import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { resetTestDatabase, testSql } from '../support/database';
import { createEventsQueue, createTestQueues, peek, queueDepth, sendRaw, testSqsClient, waitFor } from '../support/sqs';
import { balanceOf, createWallet, expectReconciled, ledgerCount, queueMessage, submit, wager } from './support/api';
import { clusterEnv, type Instance, startCluster, stopAll } from './support/cluster';

/**
 * challenge §13 concurrency scenarios 1, 2, 3, 4 and 7, with real parallelism: three separate OS processes
 * (own event loop, own connection pool, own consumer, relay and worker) over one PostgreSQL and one SQS.
 */
setDefaultTimeout(120_000);

let sql: SQL;
let sqs: SQSClient;
let cluster: Instance[];
let queues: { queueUrl: string; dlqUrl: string; eventsUrl: string };

beforeAll(async () => {
  await resetTestDatabase();
  sql = testSql();
  sqs = testSqsClient();
  queues = { ...(await createTestQueues(sqs)), eventsUrl: await createEventsQueue(sqs) };
  cluster = await startCluster(3, clusterEnv(queues));
});

afterAll(async () => {
  await stopAll(cluster ?? []);
  await sql.close();
  sqs.destroy();
});

/** Round-robin over the three instances. */
const at = (i: number) => cluster[i % cluster.length]!;

describe('scenario 4: three processes are really running', () => {
  test('three distinct PIDs, all ready', async () => {
    expect(new Set(cluster.map((i) => i.pid)).size).toBe(3);
    for (const instance of cluster) expect((await fetch(`${instance.url}/health/ready`)).status).toBe(200);
  });
});

describe('scenario 1: the same bet sent 50 times in parallel', () => {
  test('over HTTP, spread across 3 instances → one debit, 49 replays of the same result', async () => {
    const wallet = await createWallet(at(0), '100.00');
    const bet = wager(wallet, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(at(i), bet)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.body.balance?.amount === '90.00')).toBe(true);
    expect(await ledgerCount(sql, wallet.id, 'DEBIT')).toBe(1);
    await expectReconciled(at(1), [wallet.id]);
  });

  test('over SQS, one message duplicated 50 times and consumed by 3 instances → one debit', async () => {
    const wallet = await createWallet(at(0), '100.00');
    const message = queueMessage(wager(wallet, 'BET', '10.00'));
    await Promise.all(Array.from({ length: 50 }, () => sendRaw(sqs, queues.queueUrl, JSON.stringify(message), wallet.id)));
    await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0, 60_000);
    expect(await ledgerCount(sql, wallet.id, 'DEBIT')).toBe(1);
    expect(await balanceOf(sql, wallet.id)).toBe('90.00');
    await expectReconciled(at(2), [wallet.id]);
  });
});

describe('scenario 2: operations competing for the same balance', () => {
  test('§8 on 10 wallets: two 80.00 bets on 100.00 sent to two different instances at once', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(at(0), '100.00')));
    await Promise.all(
      wallets.map(async (wallet, w) => {
        const [a, b] = await Promise.all([submit(at(w), wager(wallet, 'BET', '80.00')), submit(at(w + 1), wager(wallet, 'BET', '80.00'))]);
        expect([a.status, b.status].sort()).toEqual([200, 422]);
        expect([a, b].find((r) => r.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      }),
    );
    for (const wallet of wallets) {
      expect(await balanceOf(sql, wallet.id)).toBe('20.00');
      expect(await ledgerCount(sql, wallet.id, 'DEBIT')).toBe(1);
    }
    await expectReconciled(at(0), wallets.map((w) => w.id));
  });

  test('hot wallet: 90 bets of 7.00 on 100.00 across 3 instances → exactly 14 accepted, never negative', async () => {
    const wallet = await createWallet(at(0), '100.00');
    const results = await Promise.all(Array.from({ length: 90 }, (_, i) => submit(at(i), wager(wallet, 'BET', '7.00'))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(14);
    expect(results.filter((r) => r.status === 422)).toHaveLength(76);
    expect(await balanceOf(sql, wallet.id)).toBe('2.00');
    expect(await ledgerCount(sql, wallet.id, 'DEBIT')).toBe(14);
    await expectReconciled(at(1), [wallet.id]);
  });

  test('HTTP and SQS hitting the same wallets at the same time', async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => createWallet(at(0), '1000.00')));
    const viaHttp = wallets.flatMap((w) => Array.from({ length: 10 }, () => wager(w, 'BET', '3.00')));
    const viaQueue = wallets.flatMap((w) => Array.from({ length: 10 }, () => wager(w, 'WIN', '1.00')));
    await Promise.all([
      ...viaHttp.map((b, i) => submit(at(i), b)),
      ...viaQueue.map((b) => sendRaw(sqs, queues.queueUrl, JSON.stringify(queueMessage(b)), b.walletId)),
    ]);
    await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0, 60_000);
    for (const wallet of wallets) expect(await balanceOf(sql, wallet.id)).toBe('980.00');
    await expectReconciled(at(2), wallets.map((w) => w.id));
  });
});

describe('scenario 3: distinct wallets in parallel', () => {
  test('30 wallets × BET, WIN, LOSS spread over 3 instances', async () => {
    const wallets = await Promise.all(Array.from({ length: 30 }, (_, i) => createWallet(at(i), '50.00')));
    const startedAt = performance.now();
    await Promise.all(
      wallets.flatMap((w, i) => [
        submit(at(i), wager(w, 'BET', '10.00')),
        submit(at(i + 1), wager(w, 'WIN', '25.00')),
        submit(at(i + 2), wager(w, 'LOSS', '0.00')),
      ]),
    );
    const elapsedMs = performance.now() - startedAt;
    for (const wallet of wallets) expect(await balanceOf(sql, wallet.id)).toBe('65.00');
    await expectReconciled(at(0), wallets.map((w) => w.id));
    // No global lock: 90 operations on 30 wallets do not queue behind each other.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

describe('scenario 7: ROLLBACK or REFUND delivered before its reference', () => {
  test('reversals arrive first on one instance, references later on others; workers on all instances resolve them', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => createWallet(at(0), '200.00')));
    const plan = wallets.flatMap((w) =>
      Array.from({ length: 3 }, (_, k) => {
        const bet = wager(w, 'BET', '20.00');
        const reversal = wager(w, k % 2 === 0 ? 'REFUND' : 'ROLLBACK', '20.00', { referenceExternalTransactionId: bet.externalTransactionId });
        return { bet, reversal };
      }),
    );
    const early = await Promise.all(plan.map((p) => submit(at(0), p.reversal)));
    expect(early.every((r) => r.status === 202 && r.body.status === 'PENDING_REFERENCE')).toBe(true);

    // References arrive afterwards, half over HTTP on other instances, half through the queue.
    await Promise.all(
      plan.map((p, i) =>
        i % 2 === 0 ? submit(at(1 + (i % 2)), p.bet) : sendRaw(sqs, queues.queueUrl, JSON.stringify(queueMessage(p.bet)), p.bet.walletId),
      ),
    );
    await waitFor(async () => {
      const [r] = await sql`select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'`;
      return r.n === 0;
    }, 60_000);

    for (const p of plan) {
      const [row] = await sql`select status from wager_transactions where external_transaction_id = ${p.reversal.externalTransactionId}`;
      expect(row.status).toBe('PROCESSED');
    }
    for (const wallet of wallets) expect(await balanceOf(sql, wallet.id)).toBe('200.00');
    await expectReconciled(at(1), wallets.map((w) => w.id));
    expect(await peek(sqs, queues.dlqUrl)).toHaveLength(0);
  });
});
