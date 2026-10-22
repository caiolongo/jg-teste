import { DEFAULT_OUTBOX_RETRY_POLICY, type OutboxRetryPolicy } from '../../domain/messaging/outbox-message';
import type { EventPublisher } from '../ports/messaging';
import type { UnitOfWork } from '../ports/repositories';
import type { AppLogger, Clock, Metrics } from '../ports/system';

export interface PublishRound {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * One relay round of the transactional outbox, safe with any number of concurrent publishers:
 *
 *   BEGIN → claim due rows FOR UPDATE SKIP LOCKED → publish → mark published / schedule retry → COMMIT
 *
 * Rows stay locked while they are being published, so another publisher skips them instead of sending them too.
 * If the process dies after the broker accepted but before COMMIT, the locks vanish with the connection and the
 * rows are published again by someone else: a duplicate with the same eventId, never a loss.
 * Only committed rows are visible here, so an event can never be published before its financial transaction.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly batchSize: number,
    private readonly retryPolicy: OutboxRetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY,
  ) {}

  async publishDueBatch(): Promise<PublishRound> {
    const round = await this.uow.run(async (repos) => {
      const due = await repos.outbox.claimDue(this.clock.now(), this.batchSize);
      if (due.length === 0) return { claimed: 0, published: 0, failed: 0 };

      const report = await this.publisher.publish(due);
      const publishedIds = new Set(report.published);
      const failures = new Map(report.failed.map((f) => [f.id, f.reason]));
      const now = this.clock.now();
      const published: string[] = [];
      for (const message of due) {
        if (publishedIds.has(message.id)) {
          message.markPublished(now);
          published.push(message.id);
        } else {
          message.scheduleRetry(now, this.retryPolicy);
          await repos.outbox.update(message, failures.get(message.id) ?? 'not acknowledged by the broker');
        }
      }
      await repos.outbox.markPublished(published, now);
      return { claimed: due.length, published: publishedIds.size, failed: due.length - publishedIds.size };
    });

    if (round.published > 0) this.metrics.outboxPublished(round.published);
    if (round.failed > 0) {
      this.metrics.outboxPublishFailed(round.failed);
      this.metrics.retryScheduled('outbox');
      this.logger.warn('outbox publish failed; retry scheduled', { failed: round.failed, claimed: round.claimed });
    }
    return round;
  }

  /** Pending count and age of the oldest unpublished event (outbox lag). */
  async measureBacklog(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const stats = await this.uow.run((repos) => repos.outbox.stats());
    const oldestAgeSeconds = stats.oldestPendingOccurredAt
      ? Math.max(0, (this.clock.now().getTime() - stats.oldestPendingOccurredAt.getTime()) / 1_000)
      : 0;
    this.metrics.outboxBacklog(stats.pending, oldestAgeSeconds);
    return { pending: stats.pending, oldestAgeSeconds };
  }
}
