import type { IntegrationEvent } from '../events/integration-event';
import { InvalidTransactionStateError } from '../shared/errors';

export interface OutboxRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/** 1s, 2s, 4s … capped at 5 min. Publishing is retried forever: a committed event must not be lost. */
export const DEFAULT_OUTBOX_RETRY_POLICY: OutboxRetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 300_000 };

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** The outbox id is the eventId, so a re-published message carries the same id for consumer dedup. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = Object.freeze({ ...event.toJSON() }) as Readonly<Record<string, unknown>>;
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0, event.occurredAt);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and schedules the next try with capped exponential backoff. */
  scheduleRetry(now: Date, policy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY): void {
    if (!this.isPending()) {
      throw new InvalidTransactionStateError(`outbox message ${this.id} already published`);
    }
    this._attempts += 1;
    const delayMs = Math.min(policy.baseDelayMs * 2 ** (this._attempts - 1), policy.maxDelayMs);
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
