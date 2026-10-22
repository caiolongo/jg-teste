import { describe, expect, test } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/domain/events/wagering-events';
import { LedgerDirection } from '../../../src/domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { InvalidTransactionStateError } from '../../../src/domain/shared/errors';
import { FailureCode } from '../../../src/domain/wager/failure-code';
import { WagerTransactionKind as K } from '../../../src/domain/wager/wager-transaction';
import { brl, newTx, openWallet, T0 } from './fixtures';

const ctx = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: T0 };

describe('IntegrationEvent envelopes', () => {
  test('WalletBalanceChanged carries MoneyProps strings and the wallet version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit({ money: brl('25.00'), transactionId: 'tx-1', ledgerEntryId: 'le-1', at: T0 });
    const json = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('transaction events expose their fixed type and version', () => {
    const processed = newTx(K.Loss, '0.00');
    processed.markProcessed(undefined, brl('100.00'), T0);
    const rejected = newTx(K.Bet, '1.00');
    rejected.reject(FailureCode.InsufficientFunds, brl('0.00'), T0);
    const pending = newTx(K.Refund, '1.00', { referenceExternalTransactionId: 'bet-x' });
    pending.markPendingReference(T0);

    expect(WagerTransactionProcessed.from(processed, ctx).toJSON()).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      version: 1,
      data: { kind: 'LOSS', balanceAfter: { amount: '100.00', currency: 'BRL' } },
    });
    expect(WagerTransactionRejected.from(rejected, ctx).toJSON().data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(WagerTransactionPendingReference.from(pending, ctx).toJSON().data).toMatchObject({
      referenceExternalTransactionId: 'bet-x',
      attempt: 1,
    });
  });

  test('event data is frozen', () => {
    const tx = newTx(K.Loss, '0.00');
    tx.markProcessed(undefined, brl('1.00'), T0);
    expect(Object.isFrozen(WagerTransactionProcessed.from(tx, ctx).data)).toBe(true);
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const tx = newTx(K.Loss, '0.00');
    tx.markProcessed(undefined, brl('1.00'), T0);
    return WagerTransactionProcessed.from(tx, ctx);
  };

  test('enqueue uses the eventId as id and the envelope as payload, due immediately', () => {
    const msg = OutboxMessage.enqueue(event());
    expect(msg.id).toBe('evt-1');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.payload['eventType']).toBe('WagerTransactionProcessed');
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(T0)).toBe(true);
    expect(msg.attempts).toBe(0);
  });

  test('scheduleRetry backs off exponentially with a cap', () => {
    const msg = OutboxMessage.enqueue(event());
    const policy = { baseDelayMs: 1_000, maxDelayMs: 3_000 };
    msg.scheduleRetry(T0, policy);
    expect(msg.nextAttemptAt?.getTime()).toBe(T0.getTime() + 1_000);
    expect(msg.isDue(T0)).toBe(false);
    msg.scheduleRetry(T0, policy);
    expect(msg.nextAttemptAt?.getTime()).toBe(T0.getTime() + 2_000);
    msg.scheduleRetry(T0, policy);
    expect(msg.nextAttemptAt?.getTime()).toBe(T0.getTime() + 3_000);
    expect(msg.attempts).toBe(3);
  });

  test('a published message is no longer pending or due and cannot be published again', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(T0);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(T0)).toBe(false);
    expect(() => msg.markPublished(T0)).toThrow(InvalidTransactionStateError);
    expect(() => msg.scheduleRetry(T0)).toThrow(InvalidTransactionStateError);
  });
});

describe('InboxMessage', () => {
  test('is processed once', () => {
    const msg = InboxMessage.receive({ messageId: 'm', consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: T0 });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(T0);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(T0)).toThrow(InvalidTransactionStateError);
  });
});
