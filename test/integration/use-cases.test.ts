import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { IdempotencyConflictError, WalletAlreadyExistsError, WalletNotFoundError } from '../../src/application/errors';
import { WageringQueries } from '../../src/application/queries';
import {
  type ProcessWagerCommand,
  ProcessWagerTransaction,
  type WagerResult,
} from '../../src/application/wagering/process-wager-transaction';
import { CreateWallet } from '../../src/application/wallets/create-wallet';
import { ReconcileWallet } from '../../src/application/wallets/reconcile-wallet';
import { InvalidMoneyError, InvalidWagerTransactionError } from '../../src/domain/shared/errors';
import { FailureCode } from '../../src/domain/wager/failure-code';
import { WagerTransactionStatus as S } from '../../src/domain/wager/wager-transaction';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7Generator } from '../../src/infrastructure/system';
import { resetTestDatabase, testEnv, testSql } from '../support/database';
import { FakeClock, RecordingLogger, RecordingMetrics } from '../support/fakes';

let orm: MikroORM;
let sql: SQL;
let clock: FakeClock;
let metrics: RecordingMetrics;
let logger: RecordingLogger;
let createWallet: CreateWallet;
let processWager: ProcessWagerTransaction;
let reconcile: ReconcileWallet;
let queries: WageringQueries;

const policy = { maxAttempts: 3, baseDelayMs: 1_000 };

beforeAll(async () => {
  await resetTestDatabase();
  orm = await MikroORM.init({ ...buildOrmConfig(testEnv()), pool: { min: 1, max: 30 } });
  sql = testSql();
});

beforeEach(() => {
  clock = new FakeClock();
  metrics = new RecordingMetrics();
  logger = new RecordingLogger();
  const uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 10_000 });
  const ids = new UuidV7Generator();
  createWallet = new CreateWallet(uow, ids, clock, logger);
  processWager = new ProcessWagerTransaction(uow, ids, clock, logger, metrics, policy);
  reconcile = new ReconcileWallet(uow, logger, metrics);
  queries = new WageringQueries(uow);
});

afterAll(async () => {
  await orm.close();
  await sql.close();
});

const uuid = () => crypto.randomUUID();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function newWallet(balance = '100.00') {
  return createWallet.execute({ playerId: uuid(), initialBalance: brl(balance), correlationId: 'test' });
}

function command(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: Partial<ProcessWagerCommand> = {}): ProcessWagerCommand {
  const externalTransactionId = extra.externalTransactionId ?? `tx-${uuid()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    correlationId: `corr-${uuid()}`,
    ...extra,
  };
}

async function process(cmd: ProcessWagerCommand): Promise<WagerResult> {
  const outcome = await processWager.execute(cmd);
  if (outcome.type !== 'result') throw new Error('expected a result');
  return outcome.result;
}

/** Final invariant of every test (challenge §13): stored balance == balance rebuilt from the ledger. */
async function expectConsistent(walletId: string) {
  const report = await reconcile.execute(walletId, 'invariant');
  expect(report.consistent).toBe(true);
  return report;
}

async function eventsOf(aggregateId: string): Promise<string[]> {
  const rows = await sql`select event_type from outbox_messages where aggregate_id = ${aggregateId} order by occurred_at, event_type`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

async function ledgerCount(walletId: string, direction?: string): Promise<number> {
  const rows = direction
    ? await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = ${direction}`
    : await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId}`;
  return rows[0].n;
}

describe('CreateWallet', () => {
  test('books a positive initial balance as OPENING + CREDIT + events, version 1', async () => {
    const wallet = await newWallet('1000.00');
    expect(wallet).toMatchObject({ balance: brl('1000.00'), version: 1 });
    expect(await ledgerCount(wallet.id, 'CREDIT')).toBe(1);
    const [opening] = await sql`select kind, status from wager_transactions where wallet_id = ${wallet.id}`;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });
    expect(await eventsOf(wallet.id)).toEqual(['WalletBalanceChanged']);
    await expectConsistent(wallet.id);
  });

  test('zero initial balance: no transaction, no ledger', async () => {
    const wallet = await newWallet('0.00');
    expect(await ledgerCount(wallet.id)).toBe(0);
    expect((await expectConsistent(wallet.id)).checkedEntries).toBe(0);
  });

  test('duplicate player + currency is a conflict', async () => {
    const wallet = await newWallet('10.00');
    await expect(
      createWallet.execute({ playerId: wallet.playerId, initialBalance: brl('5.00'), correlationId: 't' }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('invalid money is rejected before the database', async () => {
    await expect(createWallet.execute({ playerId: uuid(), initialBalance: brl('10.001'), correlationId: 't' })).rejects.toBeInstanceOf(InvalidMoneyError);
  });
});

describe('ProcessWagerTransaction — rules end to end', () => {
  test('BET debits, emits events and returns the observed balance', async () => {
    const wallet = await newWallet('1000.00');
    const result = await process(command(wallet, 'BET', '25.00'));
    expect(result).toMatchObject({ status: S.Processed, balance: brl('975.00'), idempotentReplay: false });
    expect(await eventsOf(result.transactionId)).toEqual(['WagerTransactionProcessed']);
    const view = await queries.getWallet(wallet.id);
    expect(view).toMatchObject({ balance: brl('975.00'), version: 2 });
    await expectConsistent(wallet.id);
  });

  test('BET without funds is REJECTED with INSUFFICIENT_FUNDS and no ledger', async () => {
    const wallet = await newWallet('10.00');
    const result = await process(command(wallet, 'BET', '25.00'));
    expect(result).toMatchObject({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds, balance: brl('10.00') });
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await eventsOf(result.transactionId)).toEqual(['WagerTransactionRejected']);
    await expectConsistent(wallet.id);
  });

  test('LOSS is PROCESSED without moving money', async () => {
    const wallet = await newWallet('50.00');
    const result = await process(command(wallet, 'LOSS', '0.00'));
    expect(result).toMatchObject({ status: S.Processed, balance: brl('50.00') });
    expect(await eventsOf(result.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect((await queries.getWallet(wallet.id)).version).toBe(1);
  });

  test('BET → WIN → ROLLBACK(WIN) → REFUND(BET) keeps balance and ledger consistent', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, 'BET', '40.00');
    await process(bet);
    const win = command(wallet, 'WIN', '90.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect((await process(win)).balance).toEqual(brl('150.00'));
    expect((await process(command(wallet, 'ROLLBACK', '90.00', { referenceExternalTransactionId: win.externalTransactionId }))).balance).toEqual(brl('60.00'));
    expect((await process(command(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }))).balance).toEqual(brl('100.00'));
    const second = await process(command(wallet, 'ROLLBACK', '40.00', { referenceExternalTransactionId: bet.externalTransactionId }));
    expect(second).toMatchObject({ status: S.Rejected, failureCode: FailureCode.AlreadyReversed });
    expect((await expectConsistent(wallet.id)).checkedEntries).toBe(5);
  });

  test('OPENING cannot be submitted and unknown wallets are refused', async () => {
    const wallet = await newWallet('1.00');
    await expect(process(command(wallet, 'OPENING', '1.00'))).rejects.toBeInstanceOf(InvalidWagerTransactionError);
    await expect(process(command({ id: uuid(), playerId: wallet.playerId }, 'BET', '1.00'))).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe('ProcessWagerTransaction — idempotency', () => {
  test('identical request is a replay with the original result and balance', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, 'BET', '25.00');
    const first = await process(bet);
    await process(command(wallet, 'BET', '5.00'));
    const replay = await process({ ...bet, correlationId: 'retry' });
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual(brl('75.00'));
    expect(metrics.count('duplicateDetected')).toBe(1);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(2);
  });

  test('same key with a different payload is a conflict, not a replay', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, 'BET', '25.00');
    await process(bet);
    await expect(process({ ...bet, money: brl('26.00') })).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(process({ ...bet, idempotencyKey: 'another-key' })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(metrics.count('idempotencyConflict')).toBe(2);
    expect((await queries.getWallet(wallet.id)).balance).toEqual(brl('75.00'));
  });

  test('the same bet sent 50 times in parallel debits once', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, 'BET', '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => process(bet)));
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === S.Processed && r.balance?.amount === '90.00')).toBe(true);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    expect((await expectConsistent(wallet.id)).storedBalance).toEqual(brl('90.00'));
  });
});

describe('ProcessWagerTransaction — concurrency', () => {
  test('§8: 100.00 and two 80.00 bets in parallel → one PROCESSED, one REJECTED, 20.00, one debit', async () => {
    const wallet = await newWallet('100.00');
    const results = await Promise.all([process(command(wallet, 'BET', '80.00')), process(command(wallet, 'BET', '80.00'))]);
    expect(results.map((r) => r.status).sort()).toEqual([S.Processed, S.Rejected]);
    expect(results.find((r) => r.status === S.Rejected)?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect((await queries.getWallet(wallet.id)).balance).toEqual(brl('20.00'));
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
    await expectConsistent(wallet.id);
  });

  test('many bets race for one hot wallet: never negative, ledger matches', async () => {
    const wallet = await newWallet('100.00');
    const results = await Promise.all(Array.from({ length: 30 }, () => process(command(wallet, 'BET', '7.00'))));
    const processed = results.filter((r) => r.status === S.Processed);
    expect(processed).toHaveLength(14);
    expect((await queries.getWallet(wallet.id)).balance).toEqual(brl('2.00'));
    await expectConsistent(wallet.id);
  });

  test('different wallets are processed in parallel without interfering', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('50.00')));
    await Promise.all(wallets.flatMap((w) => [process(command(w, 'BET', '10.00')), process(command(w, 'WIN', '5.00'))]));
    for (const w of wallets) {
      expect((await queries.getWallet(w.id)).balance).toEqual(brl('45.00'));
      await expectConsistent(w.id);
    }
  });
});

describe('ProcessWagerTransaction — out-of-order references', () => {
  test('ROLLBACK before its BET waits in PENDING_REFERENCE, then resolves', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, 'BET', '30.00');
    const rollback = command(wallet, 'ROLLBACK', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await process(rollback);
    expect(pending).toMatchObject({ status: S.PendingReference, balance: undefined });
    expect(await eventsOf(pending.transactionId)).toEqual(['WagerTransactionPendingReference']);
    expect(await processWager.retryNextPendingReference()).toBeUndefined(); // not due yet

    await process(bet);
    clock.advance(1_000);
    const retried = await processWager.retryNextPendingReference();
    expect(retried).toMatchObject({ transactionId: pending.transactionId, status: S.Processed, balance: brl('100.00') });
    expect(await process(rollback)).toMatchObject({ status: S.Processed, idempotentReplay: true });
    await expectConsistent(wallet.id);
  });

  test('gives up with REFERENCE_NOT_FOUND after the retry budget and publishes the rejection', async () => {
    const wallet = await newWallet('100.00');
    const refund = command(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: 'never-arrives' });
    const pending = await process(refund);
    clock.advance(1_000);
    expect((await processWager.retryNextPendingReference())?.status).toBe(S.PendingReference);
    clock.advance(2_000);
    const final = await processWager.retryNextPendingReference();
    expect(final).toMatchObject({ transactionId: pending.transactionId, status: S.Rejected, failureCode: FailureCode.ReferenceNotFound });
    expect(await eventsOf(pending.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect((await queries.getWallet(wallet.id)).balance).toEqual(brl('100.00'));
  });
});

describe('ProcessWagerTransaction — inbox', () => {
  test('a redelivered message is recognized by the inbox and has no effect', async () => {
    const wallet = await newWallet('100.00');
    const msg = { ...command(wallet, 'BET', '10.00'), inbox: { consumerName: 'wager-consumer', messageId: `msg-${uuid()}` } };
    expect((await processWager.execute(msg)).type).toBe('result');
    expect(await processWager.execute(msg)).toEqual({ type: 'duplicate-message' });
    const [row] = await sql`select processed_at is not null as done from inbox_messages where message_id = ${msg.inbox.messageId}`;
    expect(row.done).toBe(true);
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
  });

  test('the same operation under a new messageId is an idempotent replay', async () => {
    const wallet = await newWallet('100.00');
    const base = command(wallet, 'BET', '10.00');
    await processWager.execute({ ...base, inbox: { consumerName: 'wager-consumer', messageId: `msg-${uuid()}` } });
    const second = await processWager.execute({ ...base, inbox: { consumerName: 'wager-consumer', messageId: `msg-${uuid()}` } });
    expect(second).toMatchObject({ type: 'result', result: { idempotentReplay: true } });
    expect(await ledgerCount(wallet.id, 'DEBIT')).toBe(1);
  });
});

describe('ReconcileWallet', () => {
  test('reports, logs and counts a divergence without correcting it', async () => {
    const wallet = await newWallet('100.00');
    await process(command(wallet, 'BET', '25.00'));
    // Simulate corruption by bypassing every trigger (superuser-only replica mode).
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance = balance + 1.50 where id = ${wallet.id}`;
    });
    const report = await reconcile.execute(wallet.id, 'audit');
    expect(report).toEqual({
      walletId: wallet.id,
      storedBalance: brl('76.50'),
      calculatedBalance: brl('75.00'),
      difference: brl('1.50'),
      consistent: false,
      checkedEntries: 2,
    });
    expect(metrics.count('reconciliationDivergence')).toBe(1);
    expect(logger.lines.some((l) => l.level === 'error' && l.fields?.['walletId'] === wallet.id)).toBe(true);
    expect((await queries.getWallet(wallet.id)).balance).toEqual(brl('76.50'));
  });
});
