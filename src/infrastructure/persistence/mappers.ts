import { type LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wager/failure-code';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type { InboxRecord, LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from './schemas';

/** Rows → domain always goes through `rehydrate`: persisted state is rebuilt, not re-validated. */

const money = (amount: string, currency: string) => Money.from({ amount, currency });
const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

export const walletMapper = {
  toDomain(r: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: r.id,
      playerId: r.playerId,
      currency: r.currency,
      balance: money(r.balance, r.currency),
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    });
  },
  toRecord(w: Wallet): WalletRecord {
    return {
      id: w.id,
      playerId: w.playerId,
      currency: w.currency,
      balance: w.balance.amount,
      version: w.version,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    };
  },
};

export const transactionMapper = {
  toDomain(r: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey: r.idempotencyKey,
      payloadHash: r.payloadHash,
      walletId: r.walletId,
      playerId: r.playerId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind as WagerTransactionKind,
      money: money(r.amount, r.currency),
      referenceExternalTransactionId: orUndefined(r.referenceExternalTransactionId),
      createdAt: r.createdAt,
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: orUndefined(r.referenceTransactionId),
      failureCode: orUndefined(r.failureCode) as FailureCode | undefined,
      processedAt: orUndefined(r.processedAt),
      resultBalance:
        r.resultBalance === null || r.resultCurrency === null ? undefined : money(r.resultBalance, r.resultCurrency),
      referenceAttempts: r.referenceAttempts,
      nextReferenceAttemptAt: orUndefined(r.nextReferenceAttemptAt),
      updatedAt: r.updatedAt,
    });
  },
  toRecord(t: WagerTransaction): WagerTransactionRecord {
    return {
      id: t.id,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      idempotencyKey: t.idempotencyKey,
      payloadHash: t.payloadHash,
      walletId: t.walletId,
      playerId: t.playerId,
      roundId: t.roundId,
      gameId: t.gameId,
      kind: t.kind,
      amount: t.money.amount,
      currency: t.money.currency,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
      referenceTransactionId: t.referenceTransactionId ?? null,
      status: t.status,
      failureCode: t.failureCode ?? null,
      resultBalance: t.resultBalance?.amount ?? null,
      resultCurrency: t.resultBalance?.currency ?? null,
      referenceAttempts: t.referenceAttempts,
      nextReferenceAttemptAt: t.nextReferenceAttemptAt ?? null,
      processedAt: t.processedAt ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  },
};

export const ledgerMapper = {
  toDomain(r: LedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: r.id,
      walletId: r.walletId,
      transactionId: r.transactionId,
      direction: r.direction as LedgerDirection,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balanceBefore, r.currency),
      balanceAfter: money(r.balanceAfter, r.currency),
      walletVersion: r.walletVersion,
      createdAt: r.createdAt,
    });
  },
  toRecord(e: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: e.id,
      walletId: e.walletId,
      transactionId: e.transactionId,
      direction: e.direction,
      amount: e.money.amount,
      currency: e.money.currency,
      balanceBefore: e.balanceBefore.amount,
      balanceAfter: e.balanceAfter.amount,
      walletVersion: e.walletVersion,
      createdAt: e.createdAt,
    };
  },
};

export const inboxMapper = {
  toDomain(r: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: r.consumerName,
      messageId: r.messageId,
      payloadHash: r.payloadHash,
      receivedAt: r.receivedAt,
      processedAt: orUndefined(r.processedAt),
    });
  },
  toRecord(m: InboxMessage): InboxRecord {
    return {
      consumerName: m.consumerName,
      messageId: m.messageId,
      payloadHash: m.payloadHash,
      receivedAt: m.receivedAt,
      processedAt: m.processedAt ?? null,
    };
  },
};

export const outboxMapper = {
  toDomain(r: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: r.id,
      aggregateId: r.aggregateId,
      eventType: r.eventType,
      payload: r.payload,
      occurredAt: r.occurredAt,
      attempts: r.attempts,
      nextAttemptAt: orUndefined(r.nextAttemptAt),
      publishedAt: orUndefined(r.publishedAt),
    });
  },
  toRecord(m: OutboxMessage, lastError: string | null = null): OutboxRecord {
    return {
      id: m.id,
      aggregateId: m.aggregateId,
      eventType: m.eventType,
      payload: { ...m.payload },
      occurredAt: m.occurredAt,
      attempts: m.attempts,
      nextAttemptAt: m.nextAttemptAt ?? null,
      publishedAt: m.publishedAt ?? null,
      lastError,
    };
  },
};
