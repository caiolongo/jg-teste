import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../../../src/domain/shared/errors';
import { FailureCode } from '../../../src/domain/wager/failure-code';
import { computePayloadHash } from '../../../src/domain/wager/payload-hash';
import {
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../../src/domain/wager/wager-transaction';
import { brl, newTx, T0 } from './fixtures';

const T1 = new Date(T0.getTime() + 1_000);

describe('WagerTransaction.create', () => {
  test('starts PENDING', () => {
    const tx = newTx(K.Bet, '25.00');
    expect(tx.status).toBe(S.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  test('OPENING cannot be submitted', () => {
    expect(() => newTx(K.Opening, '10.00')).toThrow(InvalidWagerTransactionError);
  });

  test.each([[K.Refund], [K.Rollback]])('%s requires a reference', (kind) => {
    expect(() => newTx(kind, '10.00')).toThrow(InvalidWagerTransactionError);
    expect(newTx(kind, '10.00', { referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(true);
  });

  test('WIN and LOSS may reference a BET; BET cannot reference anything', () => {
    expect(newTx(K.Win, '10.00', { referenceExternalTransactionId: 'bet-1' }).referenceExternalTransactionId).toBe('bet-1');
    expect(newTx(K.Loss, '0.00', { referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(false);
    expect(() => newTx(K.Bet, '10.00', { referenceExternalTransactionId: 'x' })).toThrow(InvalidWagerTransactionError);
  });

  test.each([[K.Bet], [K.Win], [K.Refund], [K.Rollback]])('%s with zero amount is rejected', (kind) => {
    expect(() => newTx(kind, '0.00', { referenceExternalTransactionId: 'ref' })).toThrow(InvalidWagerTransactionError);
  });

  test('LOSS accepts zero and does not affect balance', () => {
    const tx = newTx(K.Loss, '0.00');
    expect(tx.affectsBalance()).toBe(false);
  });

  test('a transaction cannot reference itself', () => {
    expect(() =>
      newTx(K.Rollback, '1.00', { externalTransactionId: 'same', referenceExternalTransactionId: 'same' }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('empty identifiers are rejected', () => {
    expect(() => newTx(K.Bet, '1.00', { roundId: '  ' })).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction transitions', () => {
  test('PENDING → PROCESSED records reference, balance and time', () => {
    const tx = newTx(K.Win, '5.00');
    tx.markProcessed('tx-bet', brl('105.00'), T1);
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBe('tx-bet');
    expect(tx.resultBalance?.amount).toBe('105.00');
    expect(tx.processedAt).toEqual(T1);
  });

  test('PENDING → REJECTED keeps the failure code and observed balance', () => {
    const tx = newTx(K.Bet, '500.00');
    tx.reject(FailureCode.InsufficientFunds, brl('100.00'), T1);
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.resultBalance?.amount).toBe('100.00');
  });

  test('PENDING → FAILED', () => {
    const tx = newTx(K.Bet, '1.00');
    tx.fail(FailureCode.ProcessingFailed, T1);
    expect(tx.status).toBe(S.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  test('terminal states cannot transition again', () => {
    const processed = newTx(K.Bet, '1.00');
    processed.markProcessed(undefined, brl('99.00'), T1);
    expect(() => processed.reject(FailureCode.InsufficientFunds, undefined, T1)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markProcessed(undefined, brl('98.00'), T1)).toThrow(InvalidTransactionStateError);

    const rejected = newTx(K.Bet, '1.00');
    rejected.reject(FailureCode.InsufficientFunds, undefined, T1);
    expect(() => rejected.markProcessed(undefined, brl('1.00'), T1)).toThrow(InvalidTransactionStateError);

    const failed = newTx(K.Bet, '1.00');
    failed.fail(FailureCode.ProcessingFailed, T1);
    expect(() => failed.fail(FailureCode.ProcessingFailed, T1)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE retries with exponential backoff and can still resolve', () => {
    const tx = newTx(K.Rollback, '10.00', { referenceExternalTransactionId: 'bet-late' });
    const policy = { maxAttempts: 4, baseDelayMs: 1_000 };
    tx.markPendingReference(T0, policy);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 1_000);
    tx.markPendingReference(T0, policy);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 2_000);
    tx.markPendingReference(T0, policy);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T0.getTime() + 4_000);
    expect(tx.referenceAttempts).toBe(3);
    expect(tx.canWaitForReference(policy)).toBe(false);
    tx.markProcessed('tx-bet', brl('110.00'), T1);
    expect(tx.status).toBe(S.Processed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test('cannot wait for a reference it does not have', () => {
    expect(() => newTx(K.Bet, '1.00').markPendingReference(T0)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction queries', () => {
  test('ledger direction per kind', () => {
    const bet = newTx(K.Bet, '10.00');
    const win = newTx(K.Win, '10.00');
    const refund = newTx(K.Refund, '10.00', { referenceExternalTransactionId: 'b' });
    const rollback = newTx(K.Rollback, '10.00', { referenceExternalTransactionId: 'b' });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => newTx(K.Loss, '0.00').ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('OPENING is born PROCESSED as an internal credit', () => {
    const opening = WagerTransaction.createOpening({ id: 'o', walletId: 'w', playerId: 'p', money: brl('1000.00'), at: T0 });
    expect(opening.kind).toBe(K.Opening);
    expect(opening.status).toBe(S.Processed);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(opening.providerId).toBe('internal');
  });
});

describe('Idempotency payload hash', () => {
  const payload = {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'p',
    walletId: 'w',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('is independent of key order', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'w',
      playerId: 'p',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  test('ignores fields outside the business subset', () => {
    const withTransport = { ...payload, idempotencyKey: 'k', messageId: 'm' } as typeof payload;
    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(payload));
  });

  test('normalized amounts hash the same', () => {
    const normalized = { ...payload, money: brl('25').toJSON() };
    expect(computePayloadHash(normalized)).toBe(computePayloadHash(payload));
  });

  test('same idempotency key with a divergent payload is a conflict, not a replay', () => {
    const original = newTx(K.Bet, '25.00', { externalTransactionId: 'transaction-123' });
    const sameFieldsHash = computePayloadHash({
      ...payload,
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
    });
    const divergentHash = computePayloadHash({
      ...payload,
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      money: { amount: '26.00', currency: 'BRL' },
    });
    expect(original.matchesPayload(sameFieldsHash)).toBe(true);
    expect(original.matchesPayload(divergentHash)).toBe(false);
  });
});
