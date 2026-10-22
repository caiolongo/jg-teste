import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishReport {
  /** Ids the broker acknowledged. */
  published: string[];
  /** Ids that failed, with a short reason (kept in outbox.last_error). */
  failed: { id: string; reason: string }[];
}

/** Delivers integration events to the broker. At-least-once: a retried publish may duplicate, never lose. */
export interface EventPublisher {
  publish(messages: OutboxMessage[]): Promise<PublishReport>;
}

export const EVENT_PUBLISHER = Symbol('EventPublisher');
