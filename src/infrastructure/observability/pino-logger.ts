import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { AppLogger, LogFields } from '../../application/ports/system';
import { LogContext } from './log-context';

/**
 * Defense in depth: even if a caller passes a payload by mistake, money and bodies never reach the log.
 * Callers are expected to log identifiers and codes only.
 */
const REDACT_PATHS = ['money', 'amount', 'balance', 'payload', 'body', 'data', '*.money', '*.amount', '*.balance', '*.payload', '*.body'];

export function createPinoLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'wagering-processor' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // correlationId / messageId from the ambient request or message context, on every line.
      mixin: () => {
        const { correlationId, messageId } = LogContext.current();
        return { ...(correlationId ? { correlationId } : {}), ...(messageId ? { messageId } : {}) };
      },
    },
    destination,
  );
}

/** Structured JSON logs for the application ports. */
export class PinoAppLogger implements AppLogger {
  constructor(private readonly logger: Logger) {}

  info(message: string, fields?: LogFields): void {
    this.logger.info(fields ?? {}, message);
  }

  warn(message: string, fields?: LogFields): void {
    this.logger.warn(fields ?? {}, message);
  }

  error(message: string, fields?: LogFields): void {
    this.logger.error(fields ?? {}, message);
  }
}

/** Routes Nest's own messages (bootstrap, routing) through the same JSON logger. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
