import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { PublishOutbox } from '../../src/application/messaging/publish-outbox';
import type { EventPublisher } from '../../src/application/ports/messaging';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import type { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import { OutboxRelay } from '../../src/interfaces/workers/outbox-relay';
import { resetTestDatabase, testEnv, testSql } from '../support/database';
import { FakeClock, RecordingLogger, RecordingMetrics } from '../support/fakes';
import { createEventsQueue, drain, testSqsClient, waitFor } from '../support/sqs';

setDefaultTimeout(60_000);

let orm: MikroORM;
let sql: SQL;
let sqs: SQSClient;
let uow: MikroOrmUnitOfWork;
let createWallet: CreateWallet;
let processWager: ProcessWagerTransaction;
let eventsQueue: string;

beforeAll(async () => {
  await resetTestDatabase();
  orm = await MikroORM.init({ ...buildOrmConfig(testEnv()), pool: { min: 1, max: 20 } });
  sql = testSql();
  sqs = testSqsClient();
  uow = new MikroOrmUnitOfWork(orm);
  const ids = new UuidV7Generator();
  createWallet = new CreateWallet(uow, ids, new SystemClock(), new RecordingLogger());
  processWager = new ProcessWagerTransaction(uow, ids, new SystemClock(), new RecordingLogger(), new RecordingMetrics());
});

beforeEach(async () => {
  eventsQueue = await createEventsQueue(sqs);
  // Isolation: rows left pending by earlier tests must not leak into this test's queue.
  await sql`update outbox_messages set published_at = now(), next_attempt_at = null where published_at is null`;
});

afterAll(async () => {
  await orm.close();
  await sql.close();
  sqs.destroy();
});

const uuid = () => crypto.randomUUID();

function relay(publisher: EventPublisher = new SqsEventPublisher(sqs, eventsQueue), options: { clock?: FakeClock; batchSize?: number } = {}) {
  const metrics = new RecordingMetrics();
  const publishOutbox = new PublishOutbox(uow, publisher, options.clock ?? new SystemClock(), new RecordingLogger(), metrics, options.batchSize ?? 10, {
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
  });
  return { publishOutbox, metrics };
}

/** Publishes until nothing is due. */
async function publishAll(publishOutbox: PublishOutbox): Promise<number> {
  let total = 0;
  for (;;) {
    const round = await publishOutbox.publishDueBatch();
    total += round.published;
    if (round.claimed === 0) return total;
  }
}

/** Commits real financial transactions; each BET adds WalletBalanceChanged + WagerTransactionProcessed. */
async function placeBets(count: number) {
  const wallet = await createWallet.execute({ playerId: uuid(), initialBalance: { amount: '1000.00', currency: 'BRL' }, correlationId: 't' });
  for (let i = 0; i < count; i++) {
    const externalTransactionId = `tx-${uuid()}`;
    await processWager.execute({
      idempotencyKey: `p:${externalTransactionId}`,
      providerId: 'p',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
      correlationId: `corr-${i}`,
    });
  }
  return wallet;
}

const pendingIds = async () =>
  (await sql`select id from outbox_messages where published_at is null order by occurred_at`).map((r: { id: string }) => r.id);

describe('publishing', () => {
  test('committed events reach the queue with their eventId, and are marked published', async () => {
    const wallet = await placeBets(1);
    const ids = await pendingIds();
    expect(ids).toHaveLength(4); // opening: 2 events, bet: 2 events
    const { publishOutbox, metrics } = relay();
    expect(await publishAll(publishOutbox)).toBe(4);
    expect(await pendingIds()).toEqual([]);
    expect(metrics.calls.filter((c) => c.name === 'outboxPublished').reduce((n, c) => n + (c.args[0] as number), 0)).toBe(4);

    const received = await drain(sqs, eventsQueue);
    expect(received.map((r) => r.eventId).sort()).toEqual([...ids].sort());
    const balanceChanged = received.find((r) => r.body['eventType'] === 'WalletBalanceChanged' && (r.body['data'] as { balanceAfter: { amount: string } }).balanceAfter.amount === '999.00');
    expect(balanceChanged?.body).toMatchObject({
      eventId: balanceChanged?.eventId,
      aggregateId: wallet.id,
      version: 1,
      data: { direction: 'DEBIT', money: { amount: '1.00', currency: 'BRL' }, walletVersion: 2 },
    });
  });

  test('two concurrent publishers over the same outbox: every event once, work shared (SKIP LOCKED)', async () => {
    await placeBets(25); // 2 + 50 events
    const expected = await pendingIds();
    const a = relay(undefined, { batchSize: 5 });
    const b = relay(undefined, { batchSize: 5 });
    const [byA, byB] = await Promise.all([publishAll(a.publishOutbox), publishAll(b.publishOutbox)]);
    expect(byA + byB).toBe(expected.length);
    expect(byA).toBeGreaterThan(0);
    expect(byB).toBeGreaterThan(0);
    const received = await drain(sqs, eventsQueue);
    expect(received).toHaveLength(expected.length);
    expect(new Set(received.map((r) => r.eventId)).size).toBe(expected.length);
  });
});

describe('failures', () => {
  test('process dies after the broker accepted and before COMMIT: another publisher re-sends, consumers dedup by eventId', async () => {
    await placeBets(1);
    const ids = await pendingIds();
    const real = new SqsEventPublisher(sqs, eventsQueue);
    const dying: EventPublisher = {
      async publish(messages: OutboxMessage[]) {
        await real.publish(messages);
        throw new Error('process killed before commit');
      },
    };
    await expect(relay(dying).publishOutbox.publishDueBatch()).rejects.toThrow('process killed before commit');
    expect(await pendingIds()).toEqual(ids); // rolled back: still pending, nothing lost

    expect(await publishAll(relay().publishOutbox)).toBe(ids.length); // "another instance takes over"
    const received = await drain(sqs, eventsQueue);
    expect(received).toHaveLength(ids.length * 2); // published twice…
    expect(new Set(received.map((r) => r.eventId))).toEqual(new Set(ids)); // …but each eventId once after dedup
  });

  test('broker unavailable: retry is scheduled with backoff and the event is published once it is back', async () => {
    await placeBets(1);
    const ids = await pendingIds();
    const clock = new FakeClock();
    const broken = new SqsEventPublisher(sqs, 'http://localhost:4566/000000000000/no-such-queue');
    const failing = relay(broken, { clock });
    expect(await failing.publishOutbox.publishDueBatch()).toMatchObject({ claimed: 4, published: 0, failed: 4 });
    const [row] = await sql`select attempts, last_error is not null as has_error, next_attempt_at from outbox_messages where id = ${ids[0]!}`;
    expect(row.attempts).toBe(1);
    expect(row.has_error).toBe(true);
    expect(failing.metrics.count('outboxPublishFailed')).toBe(1);

    const recovered = relay(undefined, { clock });
    expect((await recovered.publishOutbox.publishDueBatch()).claimed).toBe(0); // not due yet: backoff respected
    clock.advance(1_000);
    expect(await publishAll(recovered.publishOutbox)).toBe(4);
    expect((await drain(sqs, eventsQueue)).map((r) => r.eventId).sort()).toEqual([...ids].sort());
    const backlog = await recovered.publishOutbox.measureBacklog();
    expect(backlog.pending).toBe(0);
  });

  test('an event is invisible to publishers until its transaction commits', async () => {
    const eventId = uuid();
    let releaseCommit!: () => void;
    const committed = new Promise<void>((resolve) => (releaseCommit = resolve));
    const writer = sql.begin(async (tx) => {
      await tx`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
               values (${eventId}, 'agg', 'WalletBalanceChanged', ${{ eventId }}, now() - interval '1 minute', now() - interval '1 minute')`;
      await committed;
    });
    await Bun.sleep(100);
    const { publishOutbox } = relay();
    expect((await publishOutbox.publishDueBatch()).claimed).toBe(0);
    releaseCommit();
    await writer;
    expect(await publishAll(publishOutbox)).toBe(1);
    expect((await drain(sqs, eventsQueue)).map((r) => r.eventId)).toEqual([eventId]);
  });
});

describe('OutboxRelay loop', () => {
  test('publishes continuously in the background and stops cleanly', async () => {
    const { publishOutbox } = relay();
    const loop = new OutboxRelay(publishOutbox, new RecordingLogger(), { enabled: true, batchSize: 10, pollIntervalMs: 50, backlogEveryMs: 100 });
    loop.start();
    try {
      await placeBets(3);
      await waitFor(async () => (await pendingIds()).length === 0);
    } finally {
      await loop.stop();
    }
    expect(await drain(sqs, eventsQueue)).toHaveLength(8);
  });
});
