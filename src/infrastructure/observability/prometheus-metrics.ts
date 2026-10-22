import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { DuplicateSource, Metrics } from '../../application/ports/system';

/**
 * Prometheus metrics (challenge §12): transactions by status, duplicates, retries, DLQ, lock conflicts,
 * outbox lag and processing latency — plus HTTP traffic and the default process metrics.
 */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions resolved, by final status and kind',
    labelNames: ['status', 'kind'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicates absorbed: idempotent replays and redelivered queue messages',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly idempotencyConflicts = new Counter({
    name: 'wagering_idempotency_conflicts_total',
    help: 'Same idempotency key or external id reused with a different payload',
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latency of ProcessWagerTransaction, by outcome',
    labelNames: ['outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliations where the stored balance differs from the ledger',
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries scheduled, by source (sqs_consumer, outbox)',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages sent to the dead-letter queue by the consumer, by reason',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and version conflicts',
    labelNames: ['kind'],
    registers: [this.registry],
  });
  private readonly outboxPublishedCount = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox events published to the broker',
    registers: [this.registry],
  });
  private readonly outboxFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Outbox events whose publish failed and was rescheduled',
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending',
    help: 'Unpublished outbox events',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox event',
    registers: [this.registry],
  });
  private readonly httpRequests = new Histogram({
    name: 'wagering_http_request_duration_seconds',
    help: 'HTTP requests by method, route and status',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  transactionResolved(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }
  duplicateDetected(source: DuplicateSource): void {
    this.duplicates.inc({ source });
  }
  idempotencyConflict(): void {
    this.idempotencyConflicts.inc();
  }
  processingDuration(seconds: number, outcome: string): void {
    this.processing.observe({ outcome }, seconds);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
  retryScheduled(source: string): void {
    this.retries.inc({ source });
  }
  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }
  lockConflict(kind: string): void {
    this.lockConflicts.inc({ kind });
  }
  outboxPublished(count: number): void {
    this.outboxPublishedCount.inc(count);
  }
  outboxPublishFailed(count: number): void {
    this.outboxFailures.inc(count);
  }
  outboxBacklog(pending: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(oldestAgeSeconds);
  }
  httpRequest(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.observe({ method, route, status: String(status) }, seconds);
  }
}
