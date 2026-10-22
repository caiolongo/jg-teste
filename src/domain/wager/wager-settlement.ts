import { LedgerDirection, type WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { Wallet } from '../wallet/wallet';
import { InvalidTransactionStateError } from '../shared/errors';
import { FailureCode } from './failure-code';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  type PendingReferencePolicy,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

export interface SettlementInput {
  /** Must be PENDING or PENDING_REFERENCE; the wallet must already be locked by the caller. */
  transaction: WagerTransaction;
  wallet: Wallet;
  /** Resolved by (providerId, referenceExternalTransactionId); undefined when absent or not requested. */
  reference: WagerTransaction | undefined;
  /** Whether the reference already has a PROCESSED REFUND/ROLLBACK pointing at it. */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
  policy?: PendingReferencePolicy;
}

export type SettlementOutcome =
  | { status: WagerTransactionStatus.Processed; ledgerEntry: WalletLedgerEntry | undefined }
  | { status: WagerTransactionStatus.Rejected; failureCode: FailureCode }
  | { status: WagerTransactionStatus.PendingReference };

/** Which reference kinds each operation may point at (challenge §7, rules 2–3). */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Applies the business rules of BET / WIN / LOSS / REFUND / ROLLBACK to a locked wallet.
 * Pure domain: mutates the given aggregates and reports the outcome; persistence is the caller's job.
 */
export function settleWagerTransaction(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, reference, at } = input;
  const policy = input.policy ?? DEFAULT_PENDING_REFERENCE_POLICY;
  if (tx.walletId !== wallet.id) {
    throw new InvalidTransactionStateError(`transaction ${tx.id} targets wallet ${tx.walletId}, got ${wallet.id}`);
  }

  const reject = (code: FailureCode): SettlementOutcome => {
    tx.reject(code, wallet.balance, at);
    return { status: WagerTransactionStatus.Rejected, failureCode: code };
  };

  if (tx.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.PlayerWalletMismatch);

  if (tx.referenceExternalTransactionId !== undefined) {
    const waiting = reference === undefined || !reference.isTerminal();
    if (waiting) {
      if (!tx.canWaitForReference(policy)) return reject(FailureCode.ReferenceNotFound);
      tx.markPendingReference(at, policy);
      return { status: WagerTransactionStatus.PendingReference };
    }
    const referenceError = validateReference(tx, reference, input.referenceAlreadyReversed);
    if (referenceError !== undefined) return reject(referenceError);
  }

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, wallet.balance, at);
    return { status: WagerTransactionStatus.Processed, ledgerEntry: undefined };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const movement = { money: tx.money, transactionId: tx.id, ledgerEntryId: input.ledgerEntryId, at };
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }
  const ledgerEntry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
  tx.markProcessed(reference?.id, wallet.balance, at);
  return { status: WagerTransactionStatus.Processed, ledgerEntry };
}

function validateReference(
  tx: WagerTransaction,
  reference: WagerTransaction,
  alreadyReversed: boolean,
): FailureCode | undefined {
  const sameContext =
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId;
  if (!sameContext) return FailureCode.ReferenceMismatch;

  if (!(ALLOWED_REFERENCE_KINDS[tx.kind] ?? []).includes(reference.kind)) return FailureCode.InvalidReferenceKind;
  if (reference.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

  if (tx.isReversal()) {
    // One reversal per transaction in total, whatever its kind (ARCHITECTURE.md §8, interpretation 1).
    if (alreadyReversed) return FailureCode.AlreadyReversed;
    if (!reference.money.equals(tx.money)) return FailureCode.AmountMismatch;
  }
  return undefined;
}
