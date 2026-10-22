export interface Clock {
  now(): Date;
}

/** Time-ordered unique ids (UUIDv7 in production). */
export interface IdGenerator {
  next(): string;
}

/** Structured fields only: identifiers and codes, never full financial payloads. */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type DuplicateSource = 'idempotency_replay' | 'inbox';

export interface Metrics {
  transactionResolved(status: string, kind: string): void;
  duplicateDetected(source: DuplicateSource): void;
  idempotencyConflict(): void;
  processingDuration(seconds: number, outcome: string): void;
  reconciliationDivergence(): void;
  retryScheduled(source: string): void;
  deadLettered(reason: string): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(count: number): void;
  outboxBacklog(pending: number, oldestAgeSeconds: number): void;
  /** A wallet lock could not be taken in time, a deadlock was broken, or a guarded version moved. */
  lockConflict(kind: string): void;
}

export const CLOCK = Symbol('Clock');
export const ID_GENERATOR = Symbol('IdGenerator');
export const APP_LOGGER = Symbol('AppLogger');
export const METRICS = Symbol('Metrics');

export const noopMetrics: Metrics = {
  transactionResolved: () => undefined,
  duplicateDetected: () => undefined,
  idempotencyConflict: () => undefined,
  processingDuration: () => undefined,
  reconciliationDivergence: () => undefined,
  retryScheduled: () => undefined,
  deadLettered: () => undefined,
  outboxPublished: () => undefined,
  outboxPublishFailed: () => undefined,
  outboxBacklog: () => undefined,
  lockConflict: () => undefined,
};

export const noopLogger: AppLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
