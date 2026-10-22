import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { hostname } from 'node:os';
import { LogContext } from '../../infrastructure/observability/log-context';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';

export const CORRELATION_HEADER = 'x-correlation-id';
/** Which replica answered (container hostname): shows load balancing and helps debugging across instances. */
export const INSTANCE_HEADER = 'x-instance-id';
const INSTANCE_ID = hostname();
const VALID = /^[\w.:-]{1,128}$/;

/** The caller's X-Correlation-Id when well-formed, otherwise a fresh one. */
export function resolveCorrelationId(request: Request): string {
  const incoming = request.header(CORRELATION_HEADER);
  return incoming && VALID.test(incoming) ? incoming : Bun.randomUUIDv7();
}

/**
 * Sets the correlation id, echoes it back, and runs the rest of the request inside a LogContext so every
 * log line of this request carries it. Also records HTTP latency by route template (never by raw path).
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(private readonly metrics: PrometheusMetrics) {}

  use(request: Request & { correlationId?: string }, response: Response, next: NextFunction): void {
    const correlationId = request.correlationId ?? resolveCorrelationId(request);
    request.correlationId = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);
    response.setHeader(INSTANCE_HEADER, INSTANCE_ID);

    const startedAt = performance.now();
    response.on('finish', () => {
      const route = (request.route as { path?: string } | undefined)?.path ?? 'unmatched';
      this.metrics.httpRequest(request.method, route, response.statusCode, (performance.now() - startedAt) / 1_000);
    });

    LogContext.run({ correlationId }, () => next());
  }
}
