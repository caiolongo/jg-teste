/** Retryable infrastructure failure (DB down, lock timeout, deadlock, serialization). Safe to retry the whole operation. */
export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientInfrastructureError';
  }
}

/** A guarded write found the row in an unexpected state (e.g. wallet version moved). Retrying re-reads fresh state. */
export class ConcurrencyConflictError extends TransientInfrastructureError {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConflictError';
  }
}

/** Application-level outcomes that are not business rejections of a transaction. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Same idempotency key (or provider + external id) with a different payload: a conflict, never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(
    message: string,
    readonly existingTransactionId: string,
  ) {
    super(message);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}
