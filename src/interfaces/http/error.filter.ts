import { type ArgumentsHost, Catch, type ExceptionFilter, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_LOGGER, type AppLogger } from '../../application/ports/system';
import { LogContext } from '../../infrastructure/observability/log-context';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation.middleware';
import { mapErrorToHttp } from './http-errors';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { correlationId?: string }>();
    const response = http.getResponse<Response>();
    const mapped = mapErrorToHttp(error);

    // Errors raised before the correlation middleware (e.g. malformed JSON in the body parser) still get an id.
    const correlationId = request.correlationId ?? resolveCorrelationId(request);
    request.correlationId = correlationId;
    response.setHeader(CORRELATION_HEADER, correlationId);

    const fields = { method: request.method, path: request.path, status: mapped.status, code: mapped.body.error.code };
    LogContext.run({ correlationId }, () => {
      if (mapped.status >= 500) {
        this.logger.error(error instanceof Error ? error.message : 'request failed', fields);
      } else {
        this.logger.warn('request refused', fields);
      }
    });

    for (const [name, value] of Object.entries(mapped.headers ?? {})) {
      response.setHeader(name, value);
    }
    response.status(mapped.status).json(mapped.body);
  }
}
