import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { FailureCode } from '../../../src/domain/wager/failure-code';
import { settleWagerTransaction, type SettlementInput } from '../../../src/domain/wager/wager-settlement';
import {
  type WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../../src/domain/wager/wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { brl, newTx, nextId, openWallet, T0, usd } from './fixtures';

const settle = (
  wallet: Wallet,
  transaction: WagerTransaction,
  extra: Partial<Omit<SettlementInput, 'wallet' | 'transaction'>> = {},
) =>
  settleWagerTransaction({
    wallet,
    transaction,
    reference: undefined,
    referenceAlreadyReversed: false,
    ledgerEntryId: nextId('le'),
    at: T0,
    ...extra,
  });

/** A BET already applied to the wallet, usable as a reference. */
function processedBet(wallet: Wallet, amount: string, overrides = {}) {
  const bet = newTx(K.Bet, amount, overrides);
  const outcome = settle(wallet, bet);
  expect(outcome.status).toBe(S.Processed);
  return bet;
}

describe('BET', () => {
  test('debits the wallet with one DEBIT entry', () => {
    const wallet = openWallet('100.00');
    const bet = newTx(K.Bet, '25.00');
    const outcome = settle(wallet, bet);
    expect(outcome.status).toBe(S.Processed);
    if (outcome.status !== S.Processed) return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('75.00');
    expect(bet.resultBalance?.amount).toBe('75.00');
  });

  test('is rejected with INSUFFICIENT_FUNDS and leaves the wallet untouched', () => {
    const wallet = openWallet('20.00');
    const bet = newTx(K.Bet, '80.00');
    expect(settle(wallet, bet)).toEqual({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(1);
    expect(bet.resultBalance?.amount).toBe('20.00');
  });

  test('§8 scenario at domain level: 100.00 and two 80.00 bets → one PROCESSED, one REJECTED, 20.00 left', () => {
    const wallet = openWallet('100.00');
    const first = settle(wallet, newTx(K.Bet, '80.00'));
    const second = settle(wallet, newTx(K.Bet, '80.00'));
    expect(first.status).toBe(S.Processed);
    expect(second).toEqual({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });
});

describe('WIN', () => {
  test('credits the wallet', () => {
    const wallet = openWallet('10.00');
    const outcome = settle(wallet, newTx(K.Win, '40.00'));
    expect(outcome.status).toBe(S.Processed);
    expect(wallet.balance.amount).toBe('50.00');
  });

  test('may reference the BET of the same round', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const win = newTx(K.Win, '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(wallet, win, { reference: bet }).status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(wallet.balance.amount).toBe('120.00');
  });
});

describe('LOSS', () => {
  test('records the result without moving the balance or creating ledger', () => {
    const wallet = openWallet('100.00');
    const loss = newTx(K.Loss, '10.00');
    expect(settle(wallet, loss)).toEqual({ status: S.Processed, ledgerEntry: undefined });
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(loss.resultBalance?.amount).toBe('100.00');
  });
});

describe('REFUND', () => {
  test('credits back a PROCESSED BET of the same amount', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '25.00');
    const refund = newTx(K.Refund, '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = settle(wallet, refund, { reference: bet });
    expect(outcome.status).toBe(S.Processed);
    if (outcome.status !== S.Processed) return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('only references a BET', () => {
    const wallet = openWallet('100.00');
    const win = newTx(K.Win, '5.00');
    settle(wallet, win);
    const refund = newTx(K.Refund, '5.00', { referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(wallet, refund, { reference: win })).toEqual({ status: S.Rejected, failureCode: FailureCode.InvalidReferenceKind });
  });

  test('cannot reverse a reference twice', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '25.00');
    const refund = newTx(K.Refund, '25.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(wallet, refund, { reference: bet, referenceAlreadyReversed: true })).toEqual({
      status: S.Rejected,
      failureCode: FailureCode.AlreadyReversed,
    });
    expect(wallet.balance.amount).toBe('75.00');
  });

  test('amount must equal the reference (no partial reversal)', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '25.00');
    const refund = newTx(K.Refund, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(wallet, refund, { reference: bet })).toEqual({ status: S.Rejected, failureCode: FailureCode.AmountMismatch });
  });

  test('reference must belong to the same round', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '25.00', { roundId: 'round-A' });
    const refund = newTx(K.Refund, '25.00', { roundId: 'round-B', referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(wallet, refund, { reference: bet })).toEqual({ status: S.Rejected, failureCode: FailureCode.ReferenceMismatch });
  });

  test('reference must be PROCESSED', () => {
    const wallet = openWallet('10.00');
    const bet = newTx(K.Bet, '50.00');
    settle(wallet, bet);
    expect(bet.status).toBe(S.Rejected);
    const refund = newTx(K.Refund, '50.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(wallet, refund, { reference: bet })).toEqual({ status: S.Rejected, failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe('ROLLBACK', () => {
  test('of a BET credits it back', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '40.00');
    const rollback = newTx(K.Rollback, '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const outcome = settle(wallet, rollback, { reference: bet });
    expect(outcome.status).toBe(S.Processed);
    if (outcome.status !== S.Processed) return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('of a WIN debits it back', () => {
    const wallet = openWallet('10.00');
    const win = newTx(K.Win, '30.00');
    settle(wallet, win);
    const rollback = newTx(K.Rollback, '30.00', { referenceExternalTransactionId: win.externalTransactionId });
    const outcome = settle(wallet, rollback, { reference: win });
    expect(outcome.status).toBe(S.Processed);
    if (outcome.status !== S.Processed) return;
    expect(outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('10.00');
  });

  test('of a REFUND debits it back', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '20.00');
    const refund = newTx(K.Refund, '20.00', { referenceExternalTransactionId: bet.externalTransactionId });
    settle(wallet, refund, { reference: bet });
    const rollback = newTx(K.Rollback, '20.00', { referenceExternalTransactionId: refund.externalTransactionId });
    expect(settle(wallet, rollback, { reference: refund }).status).toBe(S.Processed);
    expect(wallet.balance.amount).toBe('80.00');
  });

  test('that would make the balance negative is rejected with its own failure code', () => {
    const wallet = openWallet('0.00');
    const win = newTx(K.Win, '50.00');
    settle(wallet, win);
    settle(wallet, newTx(K.Bet, '45.00'));
    const rollback = newTx(K.Rollback, '50.00', { referenceExternalTransactionId: win.externalTransactionId });
    const outcome = settle(wallet, rollback, { reference: win });
    expect(outcome).toEqual({ status: S.Rejected, failureCode: FailureCode.ReversalInsufficientFunds });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.amount).toBe('5.00');
  });

  test('cannot reference another ROLLBACK', () => {
    const wallet = openWallet('100.00');
    const bet = processedBet(wallet, '10.00');
    const first = newTx(K.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    settle(wallet, first, { reference: bet });
    const second = newTx(K.Rollback, '10.00', { referenceExternalTransactionId: first.externalTransactionId });
    expect(settle(wallet, second, { reference: first })).toEqual({ status: S.Rejected, failureCode: FailureCode.InvalidReferenceKind });
  });
});

describe('out-of-order references', () => {
  const policy = { maxAttempts: 3, baseDelayMs: 1_000 };

  test('missing reference parks the transaction in PENDING_REFERENCE without touching the wallet', () => {
    const wallet = openWallet('100.00');
    const rollback = newTx(K.Rollback, '10.00', { referenceExternalTransactionId: 'bet-not-yet' });
    expect(settle(wallet, rollback, { policy })).toEqual({ status: S.PendingReference });
    expect(rollback.referenceAttempts).toBe(1);
    expect(wallet.version).toBe(1);
  });

  test('a reference that is itself still pending keeps waiting', () => {
    const wallet = openWallet('100.00');
    const pendingWin = newTx(K.Win, '5.00', { referenceExternalTransactionId: 'bet-x' });
    settle(wallet, pendingWin, { policy });
    const rollback = newTx(K.Rollback, '5.00', { referenceExternalTransactionId: pendingWin.externalTransactionId });
    expect(settle(wallet, rollback, { reference: pendingWin, policy }).status).toBe(S.PendingReference);
  });

  test('resolves once the reference arrives', () => {
    const wallet = openWallet('100.00');
    const refund = newTx(K.Refund, '30.00', { externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-late' });
    expect(settle(wallet, refund, { policy }).status).toBe(S.PendingReference);
    const bet = processedBet(wallet, '30.00', { externalTransactionId: 'bet-late' });
    expect(settle(wallet, refund, { reference: bet, policy }).status).toBe(S.Processed);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('gives up with REFERENCE_NOT_FOUND after the retry budget', () => {
    const wallet = openWallet('100.00');
    const rollback = newTx(K.Rollback, '10.00', { referenceExternalTransactionId: 'never' });
    expect(settle(wallet, rollback, { policy }).status).toBe(S.PendingReference);
    expect(settle(wallet, rollback, { policy }).status).toBe(S.PendingReference);
    expect(settle(wallet, rollback, { policy })).toEqual({ status: S.Rejected, failureCode: FailureCode.ReferenceNotFound });
    expect(rollback.referenceAttempts).toBe(2);
  });
});

describe('wallet context', () => {
  test('currency must match the wallet', () => {
    const wallet = openWallet('100.00');
    const bet = newTx(K.Bet, '10.00', { money: usd('10.00') });
    expect(settle(wallet, bet)).toEqual({ status: S.Rejected, failureCode: FailureCode.CurrencyMismatch });
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  test('player must own the wallet', () => {
    const wallet = openWallet('100.00');
    const bet = newTx(K.Bet, '10.00', { playerId: 'someone-else' });
    expect(settle(wallet, bet)).toEqual({ status: S.Rejected, failureCode: FailureCode.PlayerWalletMismatch });
  });
});
