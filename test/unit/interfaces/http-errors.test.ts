import { describe, expect, test } from 'bun:test';
import {
  ConcurrencyConflictError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/application/errors';
import { InvalidMoneyError, InvalidWagerTransactionError } from '../../../src/domain/shared/errors';
import { mapErrorToHttp, RequestValidationError } from '../../../src/interfaces/http/http-errors';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../../src/interfaces/http/ledger-cursor';

describe('mapErrorToHttp — one status per situation, on every endpoint', () => {
  test.each([
    ['invalid payload', new RequestValidationError('INVALID_PAYLOAD', 'x'), 400, 'INVALID_PAYLOAD'],
    ['invalid money', new InvalidMoneyError('x'), 400, 'INVALID_MONEY'],
    ['invalid transaction', new InvalidWagerTransactionError('x'), 400, 'INVALID_WAGER_TRANSACTION'],
    ['idempotency conflict', new IdempotencyConflictError('x', 'tx-1'), 409, 'IDEMPOTENCY_CONFLICT'],
    ['duplicate wallet', new WalletAlreadyExistsError('x'), 409, 'WALLET_ALREADY_EXISTS'],
    ['unknown wallet', new WalletNotFoundError('x'), 404, 'WALLET_NOT_FOUND'],
    ['unknown transaction', new TransactionNotFoundError('x'), 404, 'TRANSACTION_NOT_FOUND'],
    ['transient infrastructure', new TransientInfrastructureError('db down'), 503, 'TRANSIENT_FAILURE'],
    ['lost version race', new ConcurrencyConflictError('moved'), 503, 'TRANSIENT_FAILURE'],
    ['unexpected', new Error('boom'), 500, 'INTERNAL_ERROR'],
  ])('%s → %i %s', (_name, error, status, code) => {
    const mapped = mapErrorToHttp(error);
    expect(mapped.status).toBe(status);
    expect(mapped.body.error.code).toBe(code);
  });

  test('transient failures tell the client when to retry and never leak internals', () => {
    const mapped = mapErrorToHttp(new TransientInfrastructureError('connection refused 10.0.0.5:5432'));
    expect(mapped.headers).toEqual({ 'Retry-After': '1' });
    expect(mapped.body.error.message).not.toContain('10.0.0.5');
  });

  test('a conflict points at the existing transaction', () => {
    expect(mapErrorToHttp(new IdempotencyConflictError('x', 'tx-9')).body.error.details).toEqual({ existingTransactionId: 'tx-9' });
  });
});

describe('ledger cursor', () => {
  test('round-trips and is opaque', () => {
    const cursor = encodeLedgerCursor('w-1', 42);
    expect(cursor).not.toContain('42');
    expect(decodeLedgerCursor('w-1', cursor)).toBe(42);
  });

  test.each([['garbage'], [encodeLedgerCursor('other-wallet', 3)], [Buffer.from('{"w":"w-1","v":-1}').toString('base64url')]])(
    'rejects %p',
    (cursor) => {
      expect(() => decodeLedgerCursor('w-1', cursor)).toThrow(RequestValidationError);
    },
  );
});
