import { IdempotencyConflictError, TransientInfrastructureError, WalletNotFoundError } from '../../application/errors';
import { DomainError } from '../../domain/shared/errors';

export type ProcessingFailure =
  /** No retry can fix it and nothing was recorded: dead-letter now so a human sees it. */
  | { kind: 'permanent'; reason: string }
  /** May succeed later: leave it on the queue with backoff; SQS dead-letters it after maxReceiveCount. */
  | { kind: 'transient'; reason: string };

/**
 * Classification from ARCHITECTURE.md §10. Business outcomes (REJECTED, PENDING_REFERENCE) are not errors at all: the use case returns
 * them, already persisted and published, and the consumer acks. Only thrown errors reach this function.
 */
export function classifyProcessingError(error: unknown): ProcessingFailure {
  if (error instanceof IdempotencyConflictError) return { kind: 'permanent', reason: error.code };
  if (error instanceof WalletNotFoundError) return { kind: 'permanent', reason: error.code };
  if (error instanceof DomainError) return { kind: 'permanent', reason: error.code };
  if (error instanceof TransientInfrastructureError) return { kind: 'transient', reason: 'TRANSIENT_INFRASTRUCTURE' };
  // Unknown failures might be transient conditions we did not anticipate; maxReceiveCount bounds them.
  return { kind: 'transient', reason: 'UNEXPECTED' };
}

/** Visibility timeout for the next attempt: base · 2^(receiveCount − 1), capped. */
export function retryDelaySeconds(receiveCount: number, baseSeconds: number, maxSeconds: number): number {
  const attempt = Math.max(1, receiveCount);
  return Math.min(maxSeconds, baseSeconds * 2 ** (attempt - 1));
}
