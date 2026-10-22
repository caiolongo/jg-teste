import type { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import type { FailureCode } from '../wager/failure-code';
import type { WagerTransaction, WagerTransactionKind } from '../wager/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

interface TransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionBase(tx: WagerTransaction): TransactionEventBase {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function envelope(ctx: EventContext, aggregateId: string) {
  return { ...ctx, aggregateId };
}

export interface WagerTransactionProcessedData extends TransactionEventBase {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, LOSS included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (tx.resultBalance === undefined || tx.processedAt === undefined) {
      throw new Error(`transaction ${tx.id} is not processed`);
    }
    return new WagerTransactionProcessed({
      ...envelope(ctx, tx.id),
      data: {
        ...transactionBase(tx),
        ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: tx.resultBalance.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionEventBase {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (tx.failureCode === undefined) {
      throw new Error(`transaction ${tx.id} has no failure code`);
    }
    return new WagerTransactionRejected({
      ...envelope(ctx, tx.id),
      data: { ...transactionBase(tx), failureCode: tx.failureCode },
    });
  }
}

/** Permanent processing failure (status FAILED): terminal, kept for audit; operators should look at it. */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionFailed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    if (tx.failureCode === undefined) {
      throw new Error(`transaction ${tx.id} has no failure code`);
    }
    return new WagerTransactionFailed({
      ...envelope(ctx, tx.id),
      data: { ...transactionBase(tx), failureCode: tx.failureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventBase {
  referenceExternalTransactionId: string;
  attempt: number;
  nextAttemptAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.referenceExternalTransactionId === undefined || tx.nextReferenceAttemptAt === undefined) {
      throw new Error(`transaction ${tx.id} is not waiting for a reference`);
    }
    return new WagerTransactionPendingReference({
      ...envelope(ctx, tx.id),
      data: {
        ...transactionBase(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        attempt: tx.referenceAttempts,
        nextAttemptAt: tx.nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Only raised when the balance actually changes (one per ledger entry). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...envelope(ctx, wallet.id),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
