import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError, TransientInfrastructureError } from '../../application/errors';
import type { Metrics } from '../../application/ports/system';
import type { TransactionalRepositories, UnitOfWork } from '../../application/ports/repositories';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './repositories';

export interface UnitOfWorkOptions {
  /** Max wait for a row lock (hot wallet). Exceeding it is a transient error: the caller retries. */
  lockTimeoutMs: number;
  /** Counts lock timeouts, deadlocks and version conflicts. */
  metrics?: Metrics | undefined;
}

/** Which kind of lock conflict an error represents, if any. */
export function lockConflictKind(error: unknown): string | undefined {
  if (error instanceof ConcurrencyConflictError) return 'version';
  if (error instanceof LockWaitTimeoutException) return 'lock_timeout';
  if (error instanceof DeadlockException) return 'deadlock';
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '55P03') return 'lock_timeout';
  if (code === '40P01') return 'deadlock';
  if (code === '40001') return 'serialization';
  return undefined;
}

/**
 * SQLSTATEs that mean "try again": serialization failure, deadlock, lock timeout,
 * query canceled, admin/crash shutdown, cannot connect now, and the whole connection-exception class (08…).
 */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof TransientInfrastructureError) return true;
  if (error instanceof ConnectionException || error instanceof DeadlockException || error instanceof LockWaitTimeoutException) {
    return true;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NODE_CODES.has(code)) return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /connection terminated|connection refused|timeout exceeded when trying to connect/i.test(message);
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions = { lockTimeoutMs: 5_000 },
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(`set local lock_timeout = '${Math.trunc(this.options.lockTimeoutMs)}ms'`);
        return work({
          wallets: new MikroOrmWalletRepository(em),
          transactions: new MikroOrmWagerTransactionRepository(em),
          ledger: new MikroOrmLedgerRepository(em),
          inbox: new MikroOrmInboxRepository(em),
          outbox: new MikroOrmOutboxRepository(em),
        });
      });
    } catch (error) {
      const conflict = lockConflictKind(error);
      if (conflict) this.options.metrics?.lockConflict(conflict);
      if (error instanceof TransientInfrastructureError) throw error;
      if (isTransientDatabaseError(error)) {
        throw new TransientInfrastructureError(error instanceof Error ? error.message : 'transient database error', error);
      }
      throw error;
    }
  }
}
