import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { LogContext } from '../../../src/infrastructure/observability/log-context';
import { createPinoLogger, PinoAppLogger } from '../../../src/infrastructure/observability/pino-logger';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics';
import { Readiness } from '../../../src/interfaces/http/readiness';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  return { lines, logger: new PinoAppLogger(createPinoLogger('info', stream)) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('structured logs', () => {
  test('every line is JSON and carries the ambient correlationId and messageId', async () => {
    const { lines, logger } = capture();
    await LogContext.run({ correlationId: 'corr-1', messageId: 'msg-1' }, async () => {
      await Promise.resolve();
      logger.info('wager transaction resolved', { transactionId: 'tx-1', walletId: 'w-1', providerId: 'p' });
    });
    await flush();
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'wagering-processor',
      correlationId: 'corr-1',
      messageId: 'msg-1',
      transactionId: 'tx-1',
      walletId: 'w-1',
      providerId: 'p',
      msg: 'wager transaction resolved',
    });
  });

  test('contexts do not leak across concurrent requests', async () => {
    const { lines, logger } = capture();
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        LogContext.run({ correlationId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
          logger.info('done', { transactionId: id });
        }),
      ),
    );
    await flush();
    for (const line of lines) expect(line['correlationId']).toBe(line['transactionId']);
  });

  test('financial payloads are redacted even if passed by mistake', async () => {
    const { lines, logger } = capture();
    logger.info('oops', { money: '25.00', balance: '975.00', walletId: 'w' } as never);
    await flush();
    expect(lines[0]).toMatchObject({ money: '[redacted]', balance: '[redacted]', walletId: 'w' });
  });
});

describe('Prometheus metrics', () => {
  test('exposes every metric required by §12', async () => {
    const metrics = new PrometheusMetrics(false);
    metrics.transactionResolved('PROCESSED', 'BET');
    metrics.duplicateDetected('inbox');
    metrics.retryScheduled('sqs_consumer');
    metrics.deadLettered('INVALID_MESSAGE');
    metrics.lockConflict('lock_timeout');
    metrics.outboxBacklog(3, 12.5);
    metrics.processingDuration(0.02, 'PROCESSED');
    const text = await metrics.registry.metrics();
    for (const expected of [
      'wagering_transactions_total{status="PROCESSED",kind="BET"} 1',
      'wagering_duplicates_detected_total{source="inbox"} 1',
      'wagering_retries_total{source="sqs_consumer"} 1',
      'wagering_dlq_messages_total{reason="INVALID_MESSAGE"} 1',
      'wagering_lock_conflicts_total{kind="lock_timeout"} 1',
      'wagering_outbox_lag_seconds 12.5',
      'wagering_outbox_pending 3',
      'wagering_processing_duration_seconds_count{outcome="PROCESSED"} 1',
    ]) {
      expect(text).toContain(expected);
    }
  });
});

describe('Readiness', () => {
  test('ready only when every dependency answers in time', async () => {
    const ok = async () => undefined;
    const down = async () => {
      throw new Error('refused');
    };
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(await new Readiness({ postgres: ok, sqs: ok }).check()).toEqual({ ready: true, shuttingDown: false, checks: { postgres: 'up', sqs: 'up' } });
    expect((await new Readiness({ postgres: down, sqs: ok }).check()).checks).toEqual({ postgres: 'down', sqs: 'up' });
    expect((await new Readiness({ postgres: ok, sqs: slow }, 50).check()).ready).toBe(false);
  });

  test('reports not-ready once shutdown begins', async () => {
    const readiness = new Readiness({ postgres: async () => undefined });
    readiness.onModuleDestroy();
    expect(await readiness.check()).toMatchObject({ ready: false, shuttingDown: true });
  });
});
