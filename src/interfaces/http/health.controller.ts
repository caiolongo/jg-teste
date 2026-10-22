import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrometheusMetrics } from '../../infrastructure/observability/prometheus-metrics';
import { Public } from './auth.guard';
import { Readiness, type ReadinessReport } from './readiness';

/** Open endpoints (challenge §2 and §9): no authentication on health checks; metrics are scraped internally. */
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly readiness: Readiness,
    private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: the process runs and the event loop answers. No dependency checks, so a DB outage never restarts it. */
  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL and SQS reachable, and not shutting down. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessReport & { status: 'ok' | 'unavailable' }> {
    const report = await this.readiness.check();
    response.status(report.ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: report.ready ? 'ok' : 'unavailable', ...report };
  }

  @Get('metrics')
  async scrape(@Res() response: Response): Promise<void> {
    response.setHeader('Content-Type', this.metrics.registry.contentType);
    response.send(await this.metrics.registry.metrics());
  }
}
