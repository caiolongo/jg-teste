import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, TransientInfrastructureError } from '../../src/application/errors';
import type { TransactionalRepositories } from '../../src/application/ports/repositories';
import { WalletBalanceChanged } from '../../src/domain/events/wagering-events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/wager/failure-code';
import { computePayloadHash } from '../../src/domain/wager/payload-hash';
import { settleWagerTransaction } from '../../src/domain/wager/wager-settlement';
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wager/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { resetTestDatabase, testEnv } from '../support/database';

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  await resetTestDatabase();
  orm = await MikroORM.init(buildOrmConfig(testEnv()));
  uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 2_000 });
});

afterAll(async () => {
  await orm.close();
});

const uuid = () => crypto.randomUUID();
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date();

/** Opens a wallet exactly as the CreateWallet use case will: wallet + OPENING + CREDIT entry, one transaction. */
async function openWallet(balance = '100.00', currency = 'BRL') {
  const playerId = uuid();
  const initialBalance = Money.from({ amount: balance, currency });
  const at = now();
  const opening = initialBalance.isPositive() ? { transactionId: uuid(), ledgerEntryId: uuid() } : undefined;
  const { wallet, openingEntry } = Wallet.open({ id: uuid(), playerId, initialBalance, at, ...(opening ? { opening } : {}) });
  await uow.run(async (r) => {
    expect(await r.wallets.insertIfAbsent(wallet)).toBe(true);
    if (opening && openingEntry) {
      const tx = WagerTransaction.createOpening({ id: opening.transactionId, walletId: wallet.id, playerId, money: initialBalance, at });
      expect(await r.transactions.insertIfAbsent(tx)).toBe(true);
      await r.ledger.append(openingEntry);
    }
  });
  return wallet;
}

function newTx(wallet: Wallet, kind: K, amount: string, extra: { reference?: string; externalId?: string; key?: string } = {}) {
  const externalTransactionId = extra.externalId ?? `ext-${uuid()}`;
  const fields = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: extra.reference,
  };
  return WagerTransaction.create({
    ...fields,
    id: uuid(),
    idempotencyKey: extra.key ?? `provider-a:${externalTransactionId}`,
    payloadHash: computePayloadHash({ ...fields, money: fields.money.toJSON() }),
    createdAt: now(),
  });
}

/** The core write path the ProcessWagerTransaction use case will follow, under the wallet lock. */
async function apply(r: TransactionalRepositories, walletId: string, tx: WagerTransaction, reference?: WagerTransaction) {
  const wallet = await r.wallets.findByIdForUpdate(walletId);
  if (!wallet) throw new Error('wallet not found');
  expect(await r.transactions.insertIfAbsent(tx)).toBe(true);
  const outcome = settleWagerTransaction({
    transaction: tx,
    wallet,
    reference,
    referenceAlreadyReversed: reference ? await r.transactions.hasProcessedReversal(reference.id) : false,
    ledgerEntryId: uuid(),
    at: now(),
  });
  await r.transactions.update(tx);
  if (outcome.status === S.Processed && outcome.ledgerEntry) {
    await r.wallets.update(wallet);
    await r.ledger.append(outcome.ledgerEntry);
  }
  return { outcome, wallet };
}

describe('wallet repository', () => {
  test('round-trips a wallet and its opening', async () => {
    const wallet = await openWallet('1000.00');
    const loaded = await uow.run((r) => r.wallets.findById(wallet.id));
    expect(loaded?.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(loaded?.version).toBe(1);
    expect(loaded?.playerId).toBe(wallet.playerId);
    expect(loaded?.createdAt.getTime()).toBe(wallet.createdAt.getTime());
    const byPlayer = await uow.run((r) => r.wallets.findByPlayerAndCurrency(wallet.playerId, 'BRL'));
    expect(byPlayer?.id).toBe(wallet.id);
  });

  test('insertIfAbsent returns false for a second wallet of the same player and currency', async () => {
    const wallet = await openWallet('0.00');
    const duplicate = Wallet.open({ id: uuid(), playerId: wallet.playerId, initialBalance: Money.zero('BRL'), at: now() }).wallet;
    expect(await uow.run((r) => r.wallets.insertIfAbsent(duplicate))).toBe(false);
  });

  test('update is guarded by the version loaded in the transaction', async () => {
    const wallet = await openWallet('100.00');
    const stale = uow.run(async (r) => {
      const w = await r.wallets.findById(wallet.id);
      // another instance commits a debit meanwhile
      await uow.run((other) => apply(other, wallet.id, newTx(wallet, K.Bet, '10.00')));
      w!.credit({ money: brl('1.00'), transactionId: uuid(), ledgerEntryId: uuid(), at: now() });
      await r.wallets.update(w!);
    });
    await expect(stale).rejects.toBeInstanceOf(ConcurrencyConflictError);
    const final = await uow.run((r) => r.wallets.findById(wallet.id));
    expect(final?.balance.amount).toBe('90.00');
    expect(final?.version).toBe(2);
  });

  test('findByIdForUpdate blocks a second locker until the first commits', async () => {
    const wallet = await openWallet('100.00');
    const events: string[] = [];
    const first = uow.run(async (r) => {
      await r.wallets.findByIdForUpdate(wallet.id);
      events.push('first locked');
      await sleep(300);
      events.push('first commits');
    });
    await sleep(50);
    const second = uow.run(async (r) => {
      await r.wallets.findByIdForUpdate(wallet.id);
      events.push('second locked');
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['first locked', 'first commits', 'second locked']);
  });

  test('a lock held past lock_timeout surfaces as a transient error', async () => {
    const wallet = await openWallet('100.00');
    const impatient = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 100 });
    const holder = uow.run(async (r) => {
      await r.wallets.findByIdForUpdate(wallet.id);
      await sleep(600);
    });
    await sleep(50);
    const waiting = impatient.run((r) => r.wallets.findByIdForUpdate(wallet.id));
    await expect(waiting).rejects.toBeInstanceOf(TransientInfrastructureError);
    await holder;
  });
});

describe('transaction repository', () => {
  test('round-trips PROCESSED and REJECTED transactions with their result balance', async () => {
    const wallet = await openWallet('100.00');
    const bet = newTx(wallet, K.Bet, '80.00');
    const tooBig = newTx(wallet, K.Bet, '80.00');
    await uow.run((r) => apply(r, wallet.id, bet));
    await uow.run((r) => apply(r, wallet.id, tooBig));

    const [loadedBet, loadedRejected] = await uow.run(async (r) => [
      await r.transactions.findByIdempotencyKey(bet.idempotencyKey),
      await r.transactions.findByProviderAndExternalId('provider-a', tooBig.externalTransactionId),
    ]);
    expect(loadedBet?.status).toBe(S.Processed);
    expect(loadedBet?.resultBalance?.amount).toBe('20.00');
    expect(loadedBet?.processedAt).toBeInstanceOf(Date);
    expect(loadedBet?.matchesPayload(bet.payloadHash)).toBe(true);
    expect(loadedRejected?.status).toBe(S.Rejected);
    expect(loadedRejected?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(loadedRejected?.resultBalance?.amount).toBe('20.00');
  });

  test('a currency-mismatch rejection keeps the observed balance in the wallet currency', async () => {
    const wallet = await openWallet('100.00');
    const usdBet = WagerTransaction.create({
      ...newTxFields(wallet),
      money: Money.from({ amount: '5.00', currency: 'USD' }),
    });
    await uow.run((r) => apply(r, wallet.id, usdBet));
    const loaded = await uow.run((r) => r.transactions.findById(usdBet.id));
    expect(loaded?.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(loaded?.money.currency).toBe('USD');
    expect(loaded?.resultBalance?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('concurrent inserts of the same idempotency key: exactly one wins, the other sees a committed row', async () => {
    const wallet = await openWallet('100.00');
    const key = `provider-a:dup-${uuid()}`;
    const results = await Promise.all(
      [1, 2].map(() =>
        uow.run(async (r) => {
          const inserted = await r.transactions.insertIfAbsent(newTx(wallet, K.Bet, '1.00', { key }));
          await sleep(100);
          return inserted;
        }),
      ),
    );
    expect(results.sort()).toEqual([false, true]);
  });

  test('hasProcessedReversal sees a PROCESSED refund', async () => {
    const wallet = await openWallet('100.00');
    const bet = newTx(wallet, K.Bet, '10.00');
    await uow.run((r) => apply(r, wallet.id, bet));
    expect(await uow.run((r) => r.transactions.hasProcessedReversal(bet.id))).toBe(false);
    const refund = newTx(wallet, K.Refund, '10.00', { reference: bet.externalTransactionId });
    await uow.run(async (r) => apply(r, wallet.id, refund, await r.transactions.findById(bet.id)));
    expect(await uow.run((r) => r.transactions.hasProcessedReversal(bet.id))).toBe(true);
  });

  test('claimDuePendingReferences: concurrent workers take disjoint batches (SKIP LOCKED)', async () => {
    const wallet = await openWallet('100.00');
    const past = new Date(Date.now() - 60_000);
    for (let i = 0; i < 4; i++) {
      const tx = newTx(wallet, K.Rollback, '1.00', { reference: `missing-${uuid()}` });
      tx.markPendingReference(new Date(past.getTime() - 3_600_000));
      await uow.run((r) => r.transactions.insertIfAbsent(tx));
    }
    let firstBatch: string[] = [];
    const first = uow.run(async (r) => {
      firstBatch = (await r.transactions.claimDuePendingReferences(now(), 2)).map((t) => t.id);
      await sleep(300);
    });
    await sleep(50);
    const second = await uow.run(async (r) => (await r.transactions.claimDuePendingReferences(now(), 10)).map((t) => t.id));
    await first;
    expect(firstBatch).toHaveLength(2);
    expect(second.filter((id) => firstBatch.includes(id))).toEqual([]);
    expect(second.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ledger repository', () => {
  test('pages by wallet version with a stable cursor and summarizes to the stored balance', async () => {
    const wallet = await openWallet('100.00');
    for (const amount of ['10.00', '20.00', '0.50', '5.25']) {
      await uow.run((r) => apply(r, wallet.id, newTx(wallet, K.Bet, amount)));
    }
    const first = await uow.run((r) => r.ledger.listByWallet(wallet.id, { limit: 2 }));
    expect(first.entries.map((e) => e.walletVersion)).toEqual([1, 2]);
    expect(first.nextAfterVersion).toBe(2);
    const second = await uow.run((r) => r.ledger.listByWallet(wallet.id, { afterVersion: 2, limit: 2 }));
    expect(second.entries.map((e) => e.walletVersion)).toEqual([3, 4]);
    const last = await uow.run((r) => r.ledger.listByWallet(wallet.id, { afterVersion: 4, limit: 2 }));
    expect(last.entries.map((e) => e.walletVersion)).toEqual([5]);
    expect(last.nextAfterVersion).toBeUndefined();
    expect(last.entries[0]?.isBalanced()).toBe(true);

    const [summary, stored] = await uow.run(async (r) => [await r.ledger.summarize(wallet.id, 'BRL'), await r.wallets.findById(wallet.id)] as const);
    expect(summary.entries).toBe(5);
    expect(summary.calculatedBalance.amount).toBe('64.25');
    expect(summary.calculatedBalance.equals(stored!.balance)).toBe(true);
  });
});

describe('inbox and outbox repositories', () => {
  test('inbox receives a message once', async () => {
    const message = InboxMessage.receive({ messageId: `msg-${uuid()}`, consumerName: 'wager-consumer', payloadHash: 'b'.repeat(64), receivedAt: now() });
    expect(await uow.run((r) => r.inbox.tryReceive(message))).toBe(true);
    expect(await uow.run((r) => r.inbox.tryReceive(message))).toBe(false);
    message.markProcessed(now());
    await uow.run((r) => r.inbox.markProcessed(message));
    const loaded = await uow.run((r) => r.inbox.find('wager-consumer', message.messageId));
    expect(loaded?.isProcessed()).toBe(true);
  });

  test('outbox: claim with SKIP LOCKED, publish, retry and stats', async () => {
    const wallet = await openWallet('100.00');
    const entry = wallet.debit({ money: brl('1.00'), transactionId: uuid(), ledgerEntryId: uuid(), at: now() });
    const messages = [1, 2, 3].map(() =>
      OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { eventId: uuid(), correlationId: 'c', occurredAt: new Date(Date.now() - 1_000) })),
    );
    await uow.run((r) => r.outbox.addAll(messages));
    const ids = new Set(messages.map((m) => m.id));

    let held: OutboxMessage[] = [];
    const holder = uow.run(async (r) => {
      held = await r.outbox.claimDue(now(), 1);
      await sleep(300);
    });
    await sleep(50);
    const others = await uow.run(async (r) => (await r.outbox.claimDue(now(), 100)).filter((m) => ids.has(m.id)));
    await holder;
    expect(held).toHaveLength(1);
    // the second publisher skipped the row the first one held and took the other two
    expect(others.map((m) => m.id).sort()).toEqual([...ids].filter((id) => id !== held[0]!.id).sort());

    await uow.run(async (r) => {
      const [a, b] = (await r.outbox.claimDue(now(), 100)).filter((m) => ids.has(m.id));
      a!.markPublished(now());
      await r.outbox.update(a!);
      b!.scheduleRetry(now());
      await r.outbox.update(b!, 'SQS unavailable');
    });
    const stats = await uow.run((r) => r.outbox.stats());
    expect(stats.pending).toBeGreaterThanOrEqual(2);
    expect(stats.oldestPendingOccurredAt).toBeInstanceOf(Date);
    expect(messages[0]!.payload['eventType']).toBe('WalletBalanceChanged');
  });
});

describe('unit of work', () => {
  test('is atomic: a failure after writing wallet, transaction, ledger and outbox persists none of them', async () => {
    const wallet = await openWallet('100.00');
    const bet = newTx(wallet, K.Bet, '30.00');
    const eventId = uuid();
    const attempt = uow.run(async (r) => {
      const { outcome, wallet: locked } = await apply(r, wallet.id, bet);
      if (outcome.status !== S.Processed || !outcome.ledgerEntry) throw new Error('expected processed');
      await r.outbox.addAll([OutboxMessage.enqueue(WalletBalanceChanged.from(locked, outcome.ledgerEntry, { eventId, correlationId: 'c', occurredAt: now() }))]);
      throw new Error('process dies before commit');
    });
    await expect(attempt).rejects.toThrow('process dies before commit');

    const state = await uow.run(async (r) => ({
      wallet: await r.wallets.findById(wallet.id),
      tx: await r.transactions.findById(bet.id),
      ledger: await r.ledger.findByTransactionId(bet.id),
      outbox: (await r.outbox.claimDue(new Date(Date.now() + 60_000), 1_000)).find((m) => m.id === eventId),
    }));
    expect(state.wallet?.balance.amount).toBe('100.00');
    expect(state.wallet?.version).toBe(1);
    expect(state.tx).toBeUndefined();
    expect(state.ledger).toBeUndefined();
    expect(state.outbox).toBeUndefined();
  });
});

function newTxFields(wallet: Wallet) {
  const externalTransactionId = `ext-${uuid()}`;
  return {
    id: uuid(),
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: 'c'.repeat(64),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: K.Bet,
    createdAt: now(),
  };
}
