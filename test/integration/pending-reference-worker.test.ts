import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import type { PendingReferencePolicy } from '../../src/domain/wager/wager-transaction';
import { TransientInfrastructureError } from '../../src/application/errors';
import type { UnitOfWork } from '../../src/application/ports/repositories';
import { type ProcessWagerCommand, ProcessWagerTransaction } from '../../src/application/wagering/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import { ReconcileWallet } from '../../src/application/wallets/reconcile-wallet';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/system';
import { PendingReferenceWorker } from '../../src/interfaces/workers/pending-reference-worker';
import { resetTestDatabase, testEnv, testSql } from '../support/database';
import { RecordingLogger, RecordingMetrics } from '../support/fakes';
import { waitFor } from '../support/sqs';

setDefaultTimeout(60_000);

let orm: MikroORM;
let sql: SQL;
let uow: MikroOrmUnitOfWork;
let createWallet: CreateWallet;
let reconcile: ReconcileWallet;

beforeAll(async () => {
  await resetTestDatabase();
  orm = await MikroORM.init({ ...buildOrmConfig(testEnv()), pool: { min: 1, max: 30 } });
  sql = testSql();
  uow = new MikroOrmUnitOfWork(orm);
  createWallet = new CreateWallet(uow, new UuidV7Generator(), new SystemClock(), new RecordingLogger());
  reconcile = new ReconcileWallet(uow, new RecordingLogger(), new RecordingMetrics());
});

afterAll(async () => {
  await orm.close();
  await sql.close();
});

const uuid = () => crypto.randomUUID();

const processor = (policy: PendingReferencePolicy) =>
  new ProcessWagerTransaction(uow, new UuidV7Generator(), new SystemClock(), new RecordingLogger(), new RecordingMetrics(), policy);

function worker(processWager: ProcessWagerTransaction) {
  return new PendingReferenceWorker(processWager, new RecordingLogger(), { enabled: true, pollIntervalMs: 50, maxPerRound: 100 });
}

async function newWallet(balance = '100.00') {
  return createWallet.execute({ playerId: uuid(), initialBalance: { amount: balance, currency: 'BRL' }, correlationId: 't' });
}

function command(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: Partial<ProcessWagerCommand> = {}): ProcessWagerCommand {
  const externalTransactionId = extra.externalTransactionId ?? `tx-${uuid()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'g',
    kind,
    money: { amount, currency: 'BRL' },
    correlationId: 'c',
    ...extra,
  };
}

const row = async (externalId: string) =>
  (await sql`select status, failure_code, reference_attempts from wager_transactions where external_transaction_id = ${externalId}`)[0];
const balance = async (walletId: string) => (await sql`select balance::text as b from wallets where id = ${walletId}`)[0].b as string;

describe('PendingReferenceWorker', () => {
  test('the reference arriving expedites the retry: resolved on the next round, not after the backoff', async () => {
    const processWager = processor({ maxAttempts: 8, baseDelayMs: 60_000 }); // first backoff: one minute
    const loop = worker(processWager);
    loop.start();
    try {
      const wallet = await newWallet('100.00');
      const bet = command(wallet, 'BET', '30.00');
      const rollback = command(wallet, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
      await processWager.execute(rollback);
      expect((await row(rollback.externalTransactionId)).status).toBe('PENDING_REFERENCE');
      const startedAt = Date.now();
      await processWager.execute(bet);
      await waitFor(async () => (await row(rollback.externalTransactionId)).status === 'PROCESSED', 5_000, 50);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(await balance(wallet.id)).toBe('100.00');
      expect((await reconcile.execute(wallet.id, 't')).consistent).toBe(true);
    } finally {
      await loop.stop();
    }
  });

  test('without the reference it backs off and finally rejects with REFERENCE_NOT_FOUND and an event', async () => {
    const processWager = processor({ maxAttempts: 3, baseDelayMs: 100 });
    const loop = worker(processWager);
    loop.start();
    try {
      const wallet = await newWallet('100.00');
      const refund = command(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: `never-${uuid()}` });
      const outcome = await processWager.execute(refund);
      await waitFor(async () => (await row(refund.externalTransactionId)).status === 'REJECTED', 10_000, 50);
      expect(await row(refund.externalTransactionId)).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', reference_attempts: 2 });
      const events = await sql`select event_type from outbox_messages where aggregate_id = ${outcome.type === 'result' ? outcome.result.transactionId : ''} order by occurred_at`;
      expect(events.map((e: { event_type: string }) => e.event_type)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionPendingReference',
        'WagerTransactionRejected',
      ]);
      expect(await balance(wallet.id)).toBe('100.00');
    } finally {
      await loop.stop();
    }
  });

  test('three workers and the main path in parallel: every pending transaction resolved exactly once, no deadlock', async () => {
    const processWager = processor({ maxAttempts: 8, baseDelayMs: 200 });
    const wallets = await Promise.all(Array.from({ length: 5 }, () => newWallet('500.00')));
    const pairs = wallets.flatMap((w) =>
      Array.from({ length: 4 }, () => {
        const bet = command(w, 'BET', '25.00');
        return { wallet: w, bet, rollback: command(w, 'ROLLBACK', '25.00', { referenceExternalTransactionId: bet.externalTransactionId }) };
      }),
    );
    for (const p of pairs) await processWager.execute(p.rollback); // all 20 arrive before their bets

    const workers = [worker(processWager), worker(processWager), worker(processWager)];
    workers.forEach((w) => w.start());
    try {
      await Promise.all(pairs.map((p) => processWager.execute(p.bet))); // references arrive concurrently
      await waitFor(async () => {
        const [r] = await sql`select count(*)::int as n from wager_transactions where status = 'PENDING_REFERENCE'`;
        return r.n === 0;
      }, 20_000, 100);
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
    }

    for (const p of pairs) expect((await row(p.rollback.externalTransactionId)).status).toBe('PROCESSED');
    for (const w of wallets) {
      expect(await balance(w.id)).toBe('500.00');
      const [credits] = await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${w.id} and direction = 'CREDIT'`;
      expect(credits.n).toBe(5); // opening + 4 rollbacks, none twice
      expect((await reconcile.execute(w.id, 't')).consistent).toBe(true);
    }
    const [processedEvents] = await sql`
      select count(*)::int as n from outbox_messages o
        join wager_transactions t on t.id::text = o.aggregate_id
       where t.kind = 'ROLLBACK' and o.event_type = 'WagerTransactionProcessed' and t.wallet_id = any(string_to_array(${wallets.map((w) => w.id).join(',')}, ',')::uuid[])`;
    expect(processedEvents.n).toBe(20);
  });
});

describe('permanent failure while retrying → FAILED', () => {
  /**
   * Real UnitOfWork and PostgreSQL; only the wallet lookup is made to throw, standing in for inconsistent data or a bug
   * (the schema itself does not let a test corrupt rows). `failWith` decides which error the lookup raises.
   */
  function faultyUow(failWith: () => Error): UnitOfWork {
    return {
      run: (work) =>
        uow.run((repos) =>
          work({
            ...repos,
            wallets: {
              ...repos.wallets,
              findByIdForUpdate: async () => {
                throw failWith();
              },
            },
          }),
        ),
    };
  }

  async function pendingRefund() {
    const wallet = await newWallet('100.00');
    const refund = command(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: `never-${uuid()}` });
    const outcome = await processor({ maxAttempts: 8, baseDelayMs: 1 }).execute(refund);
    if (outcome.type !== 'result') throw new Error('expected a result');
    await Bun.sleep(5); // due
    return { wallet, refund, transactionId: outcome.result.transactionId };
  }

  test('a non-transient error marks the transaction FAILED, auditable, with an event, and stops retrying it', async () => {
    const { wallet, refund, transactionId } = await pendingRefund();
    const metrics = new RecordingMetrics();
    const faulty = new ProcessWagerTransaction(
      faultyUow(() => new Error('inconsistent row')),
      new UuidV7Generator(),
      new SystemClock(),
      new RecordingLogger(),
      metrics,
      { maxAttempts: 8, baseDelayMs: 1 },
    );

    const result = await faulty.retryNextPendingReference();
    expect(result).toMatchObject({ transactionId, status: 'FAILED', failureCode: 'PROCESSING_FAILED' });
    expect(await row(refund.externalTransactionId)).toMatchObject({ status: 'FAILED', failure_code: 'PROCESSING_FAILED' });
    const events = await sql`select event_type from outbox_messages where aggregate_id = ${transactionId} order by occurred_at`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionFailed']);
    expect(metrics.calls.find((c) => c.name === 'transactionResolved')?.args[0]).toBe('FAILED');

    // Terminal: never claimed again, money untouched.
    expect(await faulty.retryNextPendingReference()).toBeUndefined();
    expect(await balance(wallet.id)).toBe('100.00');
    expect((await reconcile.execute(wallet.id, 't')).consistent).toBe(true);
  });

  test('a transient error does NOT fail it: it stays pending for the next round', async () => {
    const { refund } = await pendingRefund();
    const flaky = new ProcessWagerTransaction(
      faultyUow(() => new TransientInfrastructureError('connection refused')),
      new UuidV7Generator(),
      new SystemClock(),
      new RecordingLogger(),
      new RecordingMetrics(),
      { maxAttempts: 8, baseDelayMs: 1 },
    );
    await expect(flaky.retryNextPendingReference()).rejects.toBeInstanceOf(TransientInfrastructureError);
    expect((await row(refund.externalTransactionId)).status).toBe('PENDING_REFERENCE');
  });
});
