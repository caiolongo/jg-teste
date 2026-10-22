/**
 * Stable, machine-readable reasons for REJECTED / FAILED transactions.
 * `providerAction` tells the provider what to do next without parsing messages.
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** A reversal (ROLLBACK of a WIN/REFUND) would make the balance negative. Distinct from a bet without funds. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerWalletMismatch = 'PLAYER_WALLET_MISMATCH',
  /** Referenced transaction never arrived within the retry budget. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Reference exists but belongs to another player, wallet, currency or round. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Reference kind not allowed for this operation (e.g. REFUND of a WIN). */
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  /** Reference ended REJECTED or FAILED, so there is nothing to reverse or settle. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed = 'ALREADY_REVERSED',
  /** REFUND/ROLLBACK amount differs from the reference (partial reversal is out of scope). */
  AmountMismatch = 'AMOUNT_MISMATCH',
  /** FAILED: permanent infrastructure error while processing; kept for audit. */
  ProcessingFailed = 'PROCESSING_FAILED',
}

export type ProviderAction =
  /** Business outcome is final for this transaction id; send a new transaction if appropriate. */
  | 'DO_NOT_RETRY'
  /** The payload is wrong; fix it and send under a new transaction id. */
  | 'FIX_PAYLOAD'
  /** Operator attention needed; contact support with the transaction id. */
  | 'CONTACT_SUPPORT';

export const FAILURE_CODE_ACTIONS: Readonly<Record<FailureCode, ProviderAction>> = {
  [FailureCode.InsufficientFunds]: 'DO_NOT_RETRY',
  [FailureCode.ReversalInsufficientFunds]: 'CONTACT_SUPPORT',
  [FailureCode.CurrencyMismatch]: 'FIX_PAYLOAD',
  [FailureCode.PlayerWalletMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotFound]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceMismatch]: 'FIX_PAYLOAD',
  [FailureCode.InvalidReferenceKind]: 'FIX_PAYLOAD',
  [FailureCode.ReferenceNotProcessed]: 'DO_NOT_RETRY',
  [FailureCode.AlreadyReversed]: 'DO_NOT_RETRY',
  [FailureCode.AmountMismatch]: 'FIX_PAYLOAD',
  [FailureCode.ProcessingFailed]: 'CONTACT_SUPPORT',
};
