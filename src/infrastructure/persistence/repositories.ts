import { type EntitySchema, LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  OutboxStats,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { inboxMapper, ledgerMapper, outboxMapper, transactionMapper, walletMapper } from './mappers';
import {
  InboxSchema,
  LedgerEntrySchema,
  OutboxSchema,
  type WagerTransactionRecord,
  WagerTransactionSchema,
  WalletSchema,
} from './schemas';

/**
 * Repositories over one transaction-scoped EntityManager.
 * Reads bypass the identity map (each read hits the database, so a locked read is never served stale from cache);
 * writes are explicit native statements, so their order inside the transaction is exactly the use case's order.
 */
const fresh = { disableIdentityMap: true } as const;

/** `INSERT … ON CONFLICT DO NOTHING`; true when the row was inserted. */
async function insertIgnoringConflict<T extends object>(em: EntityManager, schema: EntitySchema<T>, record: T) {
  const result = await em.createQueryBuilder(schema).insert(record).onConflict().ignore().execute('run');
  return (result as { affectedRows: number }).affectedRows === 1;
}

export class MikroOrmWalletRepository implements WalletRepository {
  /** Version each wallet had when loaded or inserted in this transaction: the guard for `update`. */
  private readonly knownVersions = new Map<string, number>();

  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, fresh);
    return record ? this.track(walletMapper.toDomain(record)) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, { ...fresh, lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? this.track(walletMapper.toDomain(record)) : undefined;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { playerId, currency }, fresh);
    return record ? this.track(walletMapper.toDomain(record)) : undefined;
  }

  async insertIfAbsent(wallet: Wallet): Promise<boolean> {
    const inserted = await insertIgnoringConflict(this.em, WalletSchema, walletMapper.toRecord(wallet));
    if (inserted) this.track(wallet);
    return inserted;
  }

  async update(wallet: Wallet): Promise<void> {
    const expectedVersion = this.knownVersions.get(wallet.id);
    if (expectedVersion === undefined) {
      throw new Error(`wallet ${wallet.id} was not loaded in this transaction`);
    }
    const { balance, version, updatedAt } = walletMapper.toRecord(wallet);
    const affected = await this.em.nativeUpdate(WalletSchema, { id: wallet.id, version: expectedVersion }, { balance, version, updatedAt });
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`wallet ${wallet.id} moved past version ${expectedVersion}`);
    }
    this.knownVersions.set(wallet.id, wallet.version);
  }

  private track(wallet: Wallet): Wallet {
    this.knownVersions.set(wallet.id, wallet.version);
    return wallet;
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    return this.one({ id });
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { id }, { ...fresh, lockMode: LockMode.PESSIMISTIC_WRITE });
    return record ? transactionMapper.toDomain(record) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.one({ idempotencyKey });
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    return this.one({ providerId, externalTransactionId });
  }

  async insertIfAbsent(transaction: WagerTransaction): Promise<boolean> {
    return insertIgnoringConflict(this.em, WagerTransactionSchema, transactionMapper.toRecord(transaction));
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const r = transactionMapper.toRecord(transaction);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: r.id },
      {
        status: r.status,
        referenceTransactionId: r.referenceTransactionId,
        failureCode: r.failureCode,
        resultBalance: r.resultBalance,
        resultCurrency: r.resultCurrency,
        referenceAttempts: r.referenceAttempts,
        nextReferenceAttemptAt: r.nextReferenceAttemptAt,
        processedAt: r.processedAt,
        updatedAt: r.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`wager transaction ${r.id} not found for update`);
    }
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async claimDuePendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { ...fresh, orderBy: { nextReferenceAttemptAt: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map((r) => transactionMapper.toDomain(r));
  }

  async expediteWaitingFor(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    const result = await this.em.execute<{ affectedRows: number }>(
      `update wager_transactions set next_reference_attempt_at = ?
        where id in (
          select id from wager_transactions
           where status = 'PENDING_REFERENCE' and provider_id = ? and reference_external_transaction_id = ?
             and next_reference_attempt_at > ?
           for update skip locked)`,
      [now, providerId, externalTransactionId, now],
      'run',
    );
    return result.affectedRows;
  }

  private async one(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, where, fresh);
    return record ? transactionMapper.toDomain(record) : undefined;
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerMapper.toRecord(entry));
  }

  async findByTransactionId(transactionId: string): Promise<WalletLedgerEntry | undefined> {
    const record = await this.em.findOne(LedgerEntrySchema, { transactionId }, fresh);
    return record ? ledgerMapper.toDomain(record) : undefined;
  }

  async listByWallet(walletId: string, options: { afterVersion?: number | undefined; limit: number }): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntrySchema,
      { walletId, walletVersion: { $gt: options.afterVersion ?? 0 } },
      { ...fresh, orderBy: { walletVersion: 'asc' }, limit: options.limit + 1 },
    );
    const page = records.slice(0, options.limit).map((r) => ledgerMapper.toDomain(r));
    const hasMore = records.length > options.limit;
    return { entries: page, nextAfterVersion: hasMore ? page.at(-1)?.walletVersion : undefined };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<{ balance: string; entries: number }[]>(
      `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(20, 2)::text as balance,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    );
    const raw = row?.balance ?? '0.00';
    // A corrupted ledger may sum below zero; Money.from only parses non-negative input, so negate explicitly.
    const calculatedBalance = raw.startsWith('-')
      ? Money.from({ amount: raw.slice(1), currency }).negate()
      : Money.from({ amount: raw, currency });
    return { calculatedBalance, entries: row?.entries ?? 0 };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    return insertIgnoringConflict(this.em, InboxSchema, inboxMapper.toRecord(message));
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxSchema, { consumerName, messageId }, fresh);
    return record ? inboxMapper.toDomain(record) : undefined;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      InboxSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      { processedAt: message.processedAt ?? null },
    );
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async addAll(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxSchema, messages.map((m) => outboxMapper.toRecord(m)));
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxSchema,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { ...fresh, orderBy: { nextAttemptAt: 'asc', occurredAt: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return records.map((r) => outboxMapper.toDomain(r));
  }

  async update(message: OutboxMessage, lastError?: string): Promise<void> {
    const r = outboxMapper.toRecord(message, lastError ?? null);
    await this.em.nativeUpdate(
      OutboxSchema,
      { id: r.id },
      { attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, publishedAt: r.publishedAt, lastError: r.lastError },
    );
  }

  async markPublished(ids: string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.em.nativeUpdate(OutboxSchema, { id: { $in: ids }, publishedAt: null }, { publishedAt: at, nextAttemptAt: null });
  }

  async stats(): Promise<OutboxStats> {
    const [row] = await this.em.execute<{ pending: number; oldest: Date | null }[]>(
      'select count(*)::int as pending, min(occurred_at) as oldest from outbox_messages where published_at is null',
    );
    return {
      pending: row?.pending ?? 0,
      oldestPendingOccurredAt: row?.oldest ? new Date(row.oldest) : undefined,
    };
  }
}
