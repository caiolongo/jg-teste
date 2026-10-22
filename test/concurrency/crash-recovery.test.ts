import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { resetTestDatabase, testSql } from '../support/database';
import { createEventsQueue, createTestQueues, drain, peek, queueDepth, sendRaw, testSqsClient, waitFor } from '../support/sqs';
import {
  balanceOf,
  createWallet,
  expectReconciled,
  ledgerCount,
  queueMessage,
  submitUntilAnswered,
  type SubmitResult,
  wager,
} from './support/api';
import { clusterEnv, Instance, startCluster, stopAll } from './support/cluster';

/**
 * challenge §13 concurrency scenarios 5, 6 and 8 with real process deaths (SIGKILL: no shutdown hooks, no ack, no commit).
 * The exact crash points come from the fault-injection decorators, enabled only through FAULT_* variables.
 */
setDefaultTimeout(180_000);

let sql: SQL;
let sqs: SQSClient;
const started: Instance[] = [];

beforeAll(async () => {
  await resetTestDatabase();
  sql = testSql();
  sqs = testSqsClient();
});

afterAll(async () => {
  await stopAll(started);
  await sql.close();
  sqs.destroy();
});

async function launch(name: string, env: Record<string, string>, awaitReady = true): Promise<Instance> {
  const instance = await Instance.start(name, env, { awaitReady });
  started.push(instance);
  return instance;
}

/** Isolation between scenarios: earlier scenarios' unpublished events must not count here. */
async function freshQueues(visibilityTimeout = 2) {
  await sql`update outbox_messages set published_at = now(), next_attempt_at = null where published_at is null`;
  return { ...(await createTestQueues(sqs, { visibilityTimeout })), eventsUrl: await createEventsQueue(sqs) };
}

const pendingOutbox = async () => (await sql`select count(*)::int as n from outbox_messages where published_at is null`)[0].n as number;

describe('scenario 5: worker killed after commit and before ack', () => {
  test('the redelivered message is absorbed by the inbox on another instance: one debit', async () => {
    const queues = await freshQueues(2);
    const writer = await launch('writer', clusterEnv(queues, { SQS_CONSUMER_ENABLED: 'false' }));
    const wallet = await createWallet(writer, '100.00');
    const message = queueMessage(wager(wallet, 'BET', '30.00'));

    const victim = await launch('victim', clusterEnv(queues, { FAULT_KILL_AFTER_COMMIT_MESSAGE_IDS: message.messageId }));
    await sendRaw(sqs, queues.queueUrl, JSON.stringify(message), wallet.id);
    await victim.exited;
    expect(victim.signalCode).toBe('SIGKILL');

    // Committed, never acked: the debit exists and the message is still on the queue.
    expect(await ledgerCount(sql, wallet.id, 'DEBIT')).toBe(1);
    const [inbox] = await sql`select processed_at is not null as done from inbox_messages where message_id = ${message.messageId}`;
    expect(inbox.done).toBe(true);
    expect(await queueDepth(sqs, queues.queueUrl)).toBe(1);

    const survivor = await launch('survivor', clusterEnv(queues));
    await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0, 30_000);
    const metrics = await (await fetch(`${survivor.url}/metrics`)).text();
    expect(metrics).toContain('wagering_duplicates_detected_total{source="inbox"} 1');
    expect(await ledgerCount(sql, wallet.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(sql, wallet.id)).toBe('70.00');
    await expectReconciled(survivor, [wallet.id]);
    await stopAll([writer, survivor]);
  });
});

describe('scenario 6: two publishers over the same outbox, one killed after publishing and before commit', () => {
  test('no event is lost; the crashed batch is re-sent with the same eventIds; consumers dedup to exactly once', async () => {
    const queues = await freshQueues();
    // Batches of 10 so the crashed publisher holds only part of the backlog and the other two share the rest.
    const quiet = { SQS_CONSUMER_ENABLED: 'false', PENDING_REFERENCE_WORKER_ENABLED: 'false', OUTBOX_BATCH_SIZE: '10' };
    // Events are produced by an instance whose relay is off, so the outbox fills up.
    const writer = await launch('writer', clusterEnv(queues, { ...quiet, OUTBOX_RELAY_ENABLED: 'false' }));
    const wallet = await createWallet(writer, '1000.00');
    for (let i = 0; i < 20; i++) await submitUntilAnswered(() => [writer], wager(wallet, 'BET', '1.00'));
    const outboxIds: string[] = (await sql`select id from outbox_messages where published_at is null`).map((r: { id: string }) => r.id);
    expect(outboxIds).toHaveLength(42);

    const crasher = await launch('crashing-publisher', clusterEnv(queues, { ...quiet, FAULT_KILL_AFTER_PUBLISH: 'true' }), false);
    await crasher.exited;
    expect(crasher.signalCode).toBe('SIGKILL');
    expect(await pendingOutbox()).toBe(42); // its batch reached the broker but the COMMIT never happened

    const publishers = await Promise.all([launch('publisher-a', clusterEnv(queues, quiet)), launch('publisher-b', clusterEnv(queues, quiet))]);
    await waitFor(async () => (await pendingOutbox()) === 0, 30_000);

    const received = await drain(sqs, queues.eventsUrl);
    const unique = new Set(received.map((r) => r.eventId));
    expect(unique).toEqual(new Set(outboxIds)); // nothing lost
    expect(received.length).toBe(42 + 10); // the killed batch (10 events) was delivered twice…
    expect(received.length - unique.size).toBe(10); // …and only those are duplicates
    await stopAll([writer, ...publishers]);
  });
});

describe('scenario 8: whole-service restart under load, with final consistency', () => {
  test('SIGKILL every instance mid-traffic, restart, retry like a provider: every operation applied exactly once', async () => {
    const queues = await freshQueues(2);
    const scenarioStart = new Date();
    const env = clusterEnv(queues);
    let live: Instance[] = await startCluster(3, env, 'gen1');
    started.push(...live);

    const wallets = await Promise.all(Array.from({ length: 3 }, () => createWallet(live[0]!, '1000.00')));
    const httpBets = wallets.flatMap((w) => Array.from({ length: 30 }, () => wager(w, 'BET', '1.00')));
    const queuedWins = wallets.flatMap((w) => Array.from({ length: 30 }, () => wager(w, 'WIN', '2.00')));
    const lateBets = wallets.map((w) => wager(w, 'BET', '5.00'));
    const earlyRollbacks = lateBets.map((b) => wager({ id: b.walletId, playerId: b.playerId }, 'ROLLBACK', '5.00', { referenceExternalTransactionId: b.externalTransactionId }));

    for (const w of queuedWins) await sendRaw(sqs, queues.queueUrl, JSON.stringify(queueMessage(w)), w.walletId);
    const traffic: Promise<SubmitResult>[] = [...earlyRollbacks, ...httpBets].map((b) => submitUntilAnswered(() => live, b, 120_000));

    // Crash the whole service while requests, messages and outbox publishing are in flight.
    await Bun.sleep(300);
    for (const instance of live) instance.kill('SIGKILL');
    await Promise.all(live.map((i) => i.exited));
    expect(live.every((i) => i.signalCode === 'SIGKILL')).toBe(true);
    live = [];

    await Bun.sleep(500);
    live = await startCluster(3, env, 'gen2');
    started.push(...live);
    traffic.push(...lateBets.map((b) => submitUntilAnswered(() => live, b, 120_000)));
    const answers = await Promise.all(traffic);
    expect(answers.every((a) => a.status === 200 || a.status === 202)).toBe(true);

    await waitFor(async () => {
      const [pending] = await sql`select count(*)::int as n from wager_transactions where status in ('PENDING', 'PENDING_REFERENCE')`;
      return pending.n === 0 && (await queueDepth(sqs, queues.queueUrl)) === 0 && (await pendingOutbox()) === 0;
    }, 90_000, 250);

    // Every operation sent exists exactly once and was applied exactly once.
    const sent = [...httpBets, ...queuedWins, ...lateBets, ...earlyRollbacks].map((b) => b.externalTransactionId);
    const walletIds = wallets.map((w) => w.id).join(',');
    const rows = await sql`
      select external_transaction_id as id, status from wager_transactions
       where provider_id = 'provider-a' and wallet_id = any(string_to_array(${walletIds}, ',')::uuid[])`;
    const byId = new Map(rows.map((r: { id: string; status: string }) => [r.id, r.status]));
    expect(rows.length).toBe(sent.length);
    for (const id of sent) expect(byId.get(id)).toBe('PROCESSED');

    for (const wallet of wallets) {
      // 1000 − 30×1 (bets) + 30×2 (wins) − 5 (late bet) + 5 (rollback) = 1030
      expect(await balanceOf(sql, wallet.id)).toBe('1030.00');
      expect(await ledgerCount(sql, wallet.id, 'DEBIT')).toBe(31);
      expect(await ledgerCount(sql, wallet.id, 'CREDIT')).toBe(1 + 30 + 1);
    }
    await expectReconciled(live[0]!, wallets.map((w) => w.id));
    expect(await peek(sqs, queues.dlqUrl)).toHaveLength(0);

    // Every committed event was published at least once.
    const outboxIds = new Set<string>(
      (await sql`select id from outbox_messages where occurred_at >= ${scenarioStart}`).map((r: { id: string }) => r.id),
    );
    const published = new Set((await drain(sqs, queues.eventsUrl)).map((r) => r.eventId));
    for (const id of outboxIds) expect(published.has(id)).toBe(true);
    await stopAll(live);
  });
});
