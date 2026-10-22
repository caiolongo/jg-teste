import { HttpException, HttpStatus } from '@nestjs/common';
import { ApplicationError, IdempotencyConflictError, TransientInfrastructureError, WalletAlreadyExistsError } from '../../application/errors';
import { DomainError } from '../../domain/shared/errors';

/** Malformed request at the HTTP boundary (schema, header, cursor). */
export class RequestValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface HttpErrorResponse {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
}

const body = (code: string, message: string, details?: unknown): ErrorBody => ({
  error: { code, message, ...(details !== undefined ? { details } : {}) },
});

/**
 * One mapping for every endpoint, so a status code alone tells the provider what to do:
 *   400 fix the payload · 404 unknown resource · 409 idempotency/uniqueness conflict (do not resend as-is)
 *   422 business rejection (final; carried in a transaction result, not here) · 503 transient (resend the same request)
 *   500 unexpected (contact support)
 */
export function mapErrorToHttp(error: unknown): HttpErrorResponse {
  if (error instanceof RequestValidationError) {
    return { status: HttpStatus.BAD_REQUEST, body: body(error.code, error.message, error.details) };
  }
  if (error instanceof DomainError) {
    return { status: HttpStatus.BAD_REQUEST, body: body(error.code, error.message) };
  }
  if (error instanceof IdempotencyConflictError) {
    return {
      status: HttpStatus.CONFLICT,
      body: body(error.code, error.message, { existingTransactionId: error.existingTransactionId }),
    };
  }
  if (error instanceof WalletAlreadyExistsError) {
    return { status: HttpStatus.CONFLICT, body: body(error.code, error.message) };
  }
  if (error instanceof ApplicationError) {
    // WalletNotFoundError, TransactionNotFoundError
    return { status: HttpStatus.NOT_FOUND, body: body(error.code, error.message) };
  }
  if (error instanceof TransientInfrastructureError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      body: body('TRANSIENT_FAILURE', 'temporary infrastructure failure; retry the same request'),
      headers: { 'Retry-After': '1' },
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = status === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : status === HttpStatus.BAD_REQUEST ? 'INVALID_PAYLOAD' : 'HTTP_ERROR';
    return { status, body: body(code, error.message) };
  }
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: body('INTERNAL_ERROR', 'unexpected error') };
}
