import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Money } from '../../domain/money/money';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT … FOR UPDATE: blocks other writers of this wallet until the transaction ends. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined>;
  /** Returns false when (playerId, currency) already has a wallet. */
  insertIfAbsent(wallet: Wallet): Promise<boolean>;
  /** Guarded by the version loaded in this transaction; throws ConcurrencyConflictError if it moved. */
  update(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** SELECT … FOR UPDATE on one transaction row. */
  findByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /**
   * INSERT … ON CONFLICT DO NOTHING. Returns false if the idempotency key or (provider, external id) exists.
   * A concurrent uncommitted duplicate makes this wait for it, so `false` always means "a committed row exists".
   */
  insertIfAbsent(transaction: WagerTransaction): Promise<boolean>;
  update(transaction: WagerTransaction): Promise<void>;
  /** Whether a PROCESSED REFUND/ROLLBACK already points at this transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Due PENDING_REFERENCE rows, locked with SKIP LOCKED so concurrent workers take disjoint batches. */
  claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]>;
  /**
   * Makes PENDING_REFERENCE rows waiting for (providerId, externalTransactionId) due now, so the worker retries them
   * on its next round instead of after the backoff. Skips rows a worker holds (SKIP LOCKED): never waits, never deadlocks.
   * Returns how many were expedited.
   */
  expediteWaitingFor(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** walletVersion of the last entry when more may follow. */
  nextAfterVersion: number | undefined;
}

export interface LedgerSummary {
  calculatedBalance: Money;
  entries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined>;
  /** Ascending by walletVersion; `afterVersion` is the cursor. */
  listByWallet(walletId: string, options: { afterVersion?: number | undefined; limit: number }): Promise<LedgerPage>;
  /** Balance rebuilt from every entry of the wallet. */
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface InboxRepository {
  /** INSERT … ON CONFLICT DO NOTHING. Returns false when (consumerName, messageId) was already received. */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingOccurredAt: Date | undefined;
}

export interface OutboxRepository {
  addAll(messages: OutboxMessage[]): Promise<void>;
  /** Due unpublished rows, locked with SKIP LOCKED so concurrent publishers take disjoint batches. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  update(message: OutboxMessage, lastError?: string): Promise<void>;
  /** One UPDATE for a whole published batch (instead of one round trip per row). */
  markPublished(ids: string[], at: Date): Promise<void>;
  stats(): Promise<OutboxStats>;
}

/** Repositories bound to one SQL transaction. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Runs `work` in one SQL transaction: everything commits together or nothing does. */
  run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
