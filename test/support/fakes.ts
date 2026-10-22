import type { AppLogger, Clock, LogFields, Metrics } from '../../src/application/ports/system';

export class FakeClock implements Clock {
  private current: number;

  constructor(start = Date.now()) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export class RecordingMetrics implements Metrics {
  readonly calls: { name: string; args: unknown[] }[] = [];

  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  transactionResolved(status: string, kind: string) {
    this.calls.push({ name: 'transactionResolved', args: [status, kind] });
  }
  duplicateDetected(source: string) {
    this.calls.push({ name: 'duplicateDetected', args: [source] });
  }
  idempotencyConflict() {
    this.calls.push({ name: 'idempotencyConflict', args: [] });
  }
  processingDuration(seconds: number, outcome: string) {
    this.calls.push({ name: 'processingDuration', args: [seconds, outcome] });
  }
  reconciliationDivergence() {
    this.calls.push({ name: 'reconciliationDivergence', args: [] });
  }
  retryScheduled(source: string) {
    this.calls.push({ name: 'retryScheduled', args: [source] });
  }
  deadLettered(reason: string) {
    this.calls.push({ name: 'deadLettered', args: [reason] });
  }
  outboxPublished(count: number) {
    this.calls.push({ name: 'outboxPublished', args: [count] });
  }
  outboxPublishFailed(count: number) {
    this.calls.push({ name: 'outboxPublishFailed', args: [count] });
  }
  lockConflict(kind: string) {
    this.calls.push({ name: 'lockConflict', args: [kind] });
  }
  outboxBacklog(pending: number, oldestAgeSeconds: number) {
    this.calls.push({ name: 'outboxBacklog', args: [pending, oldestAgeSeconds] });
  }
}

export class RecordingLogger implements AppLogger {
  readonly lines: { level: string; message: string; fields?: LogFields | undefined }[] = [];
  info(message: string, fields?: LogFields) {
    this.lines.push({ level: 'info', message, fields });
  }
  warn(message: string, fields?: LogFields) {
    this.lines.push({ level: 'warn', message, fields });
  }
  error(message: string, fields?: LogFields) {
    this.lines.push({ level: 'error', message, fields });
  }
}
