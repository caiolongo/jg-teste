import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import { WagerQueueConsumer } from '../../src/interfaces/sqs/wager-queue-consumer';
import { resetTestDatabase, testEnv, testSql } from '../support/database';
import { RecordingLogger, RecordingMetrics } from '../support/fakes';
import { createTestQueues, peek, queueDepth, sendRaw, testSqsClient, waitFor } from '../support/sqs';

// These tests wait on real SQS redelivery and lock timeouts (set per file: the preload only reaches the first file).
setDefaultTimeout(60_000);

const CONSUMER = 'wager-transactions-consumer';

let orm: MikroORM;
let sql: SQL;
let sqs: SQSClient;
let createWallet: CreateWallet;

beforeAll(async () => {
  await resetTestDatabase();
  orm = await MikroORM.init({ ...buildOrmConfig(testEnv()), pool: { min: 1, max: 30 } });
  sql = testSql();
  sqs = testSqsClient();
  createWallet = new CreateWallet(new MikroOrmUnitOfWork(orm), new UuidV7Generator(), new SystemClock(), new RecordingLogger());
});

afterAll(async () => {
  await orm.close();
  await sql.close();
  sqs.destroy();
});

const uuid = () => crypto.randomUUID();

function makeConsumer(queues: { queueUrl: string; dlqUrl: string }, options: { lockTimeoutMs?: number; concurrency?: number } = {}) {
  const metrics = new RecordingMetrics();
  const logger = new RecordingLogger();
  const uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: options.lockTimeoutMs ?? 5_000 });
  const processWager = new ProcessWagerTransaction(uow, new UuidV7Generator(), new SystemClock(), logger, metrics);
  const consumer = new WagerQueueConsumer(sqs, processWager, logger, metrics, {
    ...queues,
    consumerName: CONSUMER,
    concurrency: options.concurrency ?? 2,
    waitTimeSeconds: 1,
    maxMessages: 10,
    retryBaseSeconds: 1,
    retryMaxSeconds: 4,
    shutdownTimeoutMs: 10_000,
  });
  return { consumer, metrics, logger, processWager };
}

async function newWallet(balance = '100.00') {
  return createWallet.execute({ playerId: uuid(), initialBalance: { amount: balance, currency: 'BRL' }, correlationId: 'test' });
}

function envelope(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = `transaction-${uuid()}`;
  return {
    messageId: `msg-${uuid()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind,
      money: { amount, currency: 'BRL' },
      ...extra,
    },
  };
}

const send = (queueUrl: string, message: ReturnType<typeof envelope>) => sendRaw(sqs, queueUrl, JSON.stringify(message), message.data.walletId);

const debits = async (walletId: string) =>
  (await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`)[0].n as number;
const balance = async (walletId: string) => (await sql`select balance::text as b from wallets where id = ${walletId}`)[0].b as string;
const statusOf = async (externalId: string) =>
  (await sql`select status, failure_code from wager_transactions where external_transaction_id = ${externalId}`)[0];

describe('ack only after commit', () => {
  test('a valid message is processed, recorded in the inbox and removed from the queue', async () => {
    const queues = await createTestQueues(sqs);
    const { consumer } = makeConsumer(queues);
    const wallet = await newWallet('100.00');
    const message = envelope(wallet, 'BET', '25.00');
    await send(queues.queueUrl, message);
    consumer.start();
    try {
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0 && (await debits(wallet.id)) === 1);
    } finally {
      await consumer.stop();
    }
    expect(await balance(wallet.id)).toBe('75.00');
    const [inbox] = await sql`select processed_at is not null as done from inbox_messages where consumer_name = ${CONSUMER} and message_id = ${message.messageId}`;
    expect(inbox.done).toBe(true);
  });

  test('business outcomes are acked: REJECTED and PENDING_REFERENCE never reach the DLQ', async () => {
    const queues = await createTestQueues(sqs);
    const { consumer } = makeConsumer(queues);
    const wallet = await newWallet('10.00');
    const rejected = envelope(wallet, 'BET', '50.00');
    const pending = envelope(wallet, 'ROLLBACK', '5.00', { referenceExternalTransactionId: 'not-yet' });
    await send(queues.queueUrl, rejected);
    await send(queues.queueUrl, pending);
    consumer.start();
    try {
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0 && (await statusOf(pending.data.externalTransactionId)) !== undefined);
    } finally {
      await consumer.stop();
    }
    expect(await statusOf(rejected.data.externalTransactionId)).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect((await statusOf(pending.data.externalTransactionId)).status).toBe('PENDING_REFERENCE');
    expect(await peek(sqs, queues.dlqUrl)).toHaveLength(0);
  });
});

describe('redelivery', () => {
  test('the same message delivered twice has one effect (inbox)', async () => {
    const queues = await createTestQueues(sqs);
    const { consumer, metrics } = makeConsumer(queues);
    const wallet = await newWallet('100.00');
    const message = envelope(wallet, 'BET', '10.00');
    await send(queues.queueUrl, message);
    await send(queues.queueUrl, message); // broker-level duplicate: new SQS id, same messageId
    consumer.start();
    try {
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0 && metrics.count('duplicateDetected') === 1);
    } finally {
      await consumer.stop();
    }
    expect(await debits(wallet.id)).toBe(1);
    expect(await balance(wallet.id)).toBe('90.00');
  });

  test('worker dies after commit and before ack: the redelivery is absorbed', async () => {
    const queues = await createTestQueues(sqs, { visibilityTimeout: 1 });
    const { consumer, metrics, processWager } = makeConsumer(queues);
    const wallet = await newWallet('100.00');
    const message = envelope(wallet, 'BET', '30.00');
    await send(queues.queueUrl, message);

    // "Worker 1": receives, commits through the use case, then dies without deleting the message.
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.queueUrl, WaitTimeSeconds: 1 }));
    expect(received.Messages).toHaveLength(1);
    await processWager.execute({
      ...message.data,
      correlationId: message.messageId,
      inbox: { consumerName: CONSUMER, messageId: message.messageId },
    });
    expect(await debits(wallet.id)).toBe(1);

    // "Worker 2" picks the message up once its visibility expires.
    consumer.start();
    try {
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0);
    } finally {
      await consumer.stop();
    }
    expect(metrics.count('duplicateDetected')).toBe(1);
    expect(await debits(wallet.id)).toBe(1);
    expect(await balance(wallet.id)).toBe('70.00');
  });

  test('three consumers on one queue with every message duplicated: exactly one debit each', async () => {
    const queues = await createTestQueues(sqs);
    const wallets = await Promise.all([newWallet('1000.00'), newWallet('1000.00')]);
    const messages = wallets.flatMap((w) => Array.from({ length: 10 }, () => envelope(w, 'BET', '1.00')));
    for (const m of messages) {
      await send(queues.queueUrl, m);
      await send(queues.queueUrl, m);
    }
    const consumers = [makeConsumer(queues), makeConsumer(queues), makeConsumer(queues)];
    consumers.forEach((c) => c.consumer.start());
    try {
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0, 30_000);
    } finally {
      await Promise.all(consumers.map((c) => c.consumer.stop()));
    }
    for (const w of wallets) {
      expect(await debits(w.id)).toBe(10);
      expect(await balance(w.id)).toBe('990.00');
    }
  });
});

describe('dead-letter queue', () => {
  test.each([
    ['malformed JSON', (_w: { id: string; playerId: string }) => '{"messageId": ', 'INVALID_MESSAGE'],
    ['envelope out of contract', (w: { id: string; playerId: string }) => JSON.stringify({ ...envelope(w, 'BET', '1.00'), type: 'Other' }), 'INVALID_MESSAGE'],
    ['OPENING submitted', (w: { id: string; playerId: string }) => JSON.stringify(envelope(w, 'OPENING', '1.00')), 'INVALID_MESSAGE'],
    ['invalid amount', (w: { id: string; playerId: string }) => JSON.stringify(envelope(w, 'BET', '1.001')), 'INVALID_MONEY'],
    ['unknown wallet', (w: { id: string; playerId: string }) => JSON.stringify(envelope({ id: crypto.randomUUID(), playerId: w.playerId }, 'BET', '1.00')), 'WALLET_NOT_FOUND'],
  ])('%s → DLQ on the first receive, with the reason attached', async (_name, body, reason) => {
    const queues = await createTestQueues(sqs);
    const { consumer, metrics } = makeConsumer(queues);
    const wallet = await newWallet('10.00');
    await sendRaw(sqs, queues.queueUrl, body(wallet), wallet.id);
    consumer.start();
    try {
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0);
    } finally {
      await consumer.stop();
    }
    const [dead] = await peek(sqs, queues.dlqUrl);
    expect(dead?.MessageAttributes?.['errorCode']?.StringValue).toBe(reason);
    expect(dead?.MessageAttributes?.['receiveCount']?.StringValue).toBe('1');
    expect(metrics.calls.filter((c) => c.name === 'deadLettered').map((c) => c.args[0])).toEqual([reason]);
    expect(await debits(wallet.id)).toBe(0);
  });

  test('idempotency conflict → DLQ, original transaction untouched', async () => {
    const queues = await createTestQueues(sqs);
    const { consumer } = makeConsumer(queues);
    const wallet = await newWallet('100.00');
    const original = envelope(wallet, 'BET', '10.00');
    const conflicting = { ...original, messageId: `msg-${uuid()}`, data: { ...original.data, money: { amount: '99.00', currency: 'BRL' } } };
    await send(queues.queueUrl, original);
    await send(queues.queueUrl, conflicting);
    consumer.start();
    try {
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0);
    } finally {
      await consumer.stop();
    }
    const [dead] = await peek(sqs, queues.dlqUrl);
    expect(dead?.MessageAttributes?.['errorCode']?.StringValue).toBe('IDEMPOTENCY_CONFLICT');
    expect(await balance(wallet.id)).toBe('90.00');
  });
});

describe('transient failures', () => {
  /** Holds the wallet row lock in another transaction, so the consumer hits a real lock timeout. */
  async function holdWalletLock(walletId: string, ms: number) {
    await sql.begin(async (tx) => {
      await tx`select id from wallets where id = ${walletId} for update`;
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  test('a lock timeout is retried with backoff and succeeds once the lock is free', async () => {
    const queues = await createTestQueues(sqs);
    const { consumer, metrics } = makeConsumer(queues, { lockTimeoutMs: 200 });
    const wallet = await newWallet('100.00');
    const lock = holdWalletLock(wallet.id, 1_500);
    await send(queues.queueUrl, envelope(wallet, 'BET', '10.00'));
    consumer.start();
    try {
      await lock;
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0 && (await debits(wallet.id)) === 1, 20_000);
    } finally {
      await consumer.stop();
    }
    expect(metrics.count('retryScheduled')).toBeGreaterThanOrEqual(1);
    expect(await peek(sqs, queues.dlqUrl)).toHaveLength(0);
    expect(await balance(wallet.id)).toBe('90.00');
  });

  test('a failure that outlasts maxReceiveCount is moved to the DLQ by SQS itself', async () => {
    const queues = await createTestQueues(sqs, { maxReceiveCount: 2 });
    const { consumer, metrics } = makeConsumer(queues, { lockTimeoutMs: 200 });
    const wallet = await newWallet('100.00');
    const lock = holdWalletLock(wallet.id, 8_000);
    await send(queues.queueUrl, envelope(wallet, 'BET', '10.00'));
    consumer.start();
    try {
      await waitFor(async () => (await peek(sqs, queues.dlqUrl)).length === 1, 20_000, 500);
    } finally {
      await consumer.stop();
      await lock;
    }
    expect(metrics.count('retryScheduled')).toBeGreaterThanOrEqual(2);
    expect(metrics.count('deadLettered')).toBe(0); // the broker moved it, not the consumer
    expect(await debits(wallet.id)).toBe(0);
  });
});

describe('graceful shutdown', () => {
  test('stop() drains in-flight work and releases the rest; a new consumer finishes with no loss or duplicate', async () => {
    const queues = await createTestQueues(sqs);
    const wallets = await Promise.all([newWallet('1000.00'), newWallet('1000.00'), newWallet('1000.00')]);
    for (const w of wallets) for (let i = 0; i < 10; i++) await send(queues.queueUrl, envelope(w, 'BET', '2.00'));

    const first = makeConsumer(queues);
    first.consumer.start();
    await waitFor(async () => (await sql`select count(*)::int as n from inbox_messages where consumer_name = ${CONSUMER}`)[0].n > 0);
    await first.consumer.stop(); // what SIGTERM triggers

    const second = makeConsumer(queues);
    second.consumer.start();
    try {
      await waitFor(async () => (await queueDepth(sqs, queues.queueUrl)) === 0, 30_000);
    } finally {
      await second.consumer.stop();
    }
    for (const w of wallets) {
      expect(await debits(w.id)).toBe(10);
      expect(await balance(w.id)).toBe('980.00');
    }
    expect(await peek(sqs, queues.dlqUrl)).toHaveLength(0);
  });
});
