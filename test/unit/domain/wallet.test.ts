import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidWalletError,
} from '../../../src/domain/shared/errors';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { brl, openWallet, T0, usd } from './fixtures';

const T1 = new Date('2026-07-29T15:01:00.000Z');
const move = (amount: string, n = 1) => ({ money: brl(amount), transactionId: `tx-${n}`, ledgerEntryId: `le-${n}`, at: T1 });

describe('Wallet.open', () => {
  test('positive initial balance produces an OPENING credit from zero, version 1', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('1000.00'),
      at: T0,
      opening: { transactionId: 'tx-open', ledgerEntryId: 'le-open' },
    });
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
    expect(openingEntry?.transactionId).toBe('tx-open');
  });

  test('zero initial balance has no ledger entry', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at: T0 });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('opening ids are required exactly when the balance is positive', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at: T0 })).toThrow(InvalidWalletError);
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at: T0, opening: { transactionId: 't', ledgerEntryId: 'l' } }),
    ).toThrow(InvalidWalletError);
  });

  test('rejects a negative initial balance', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00').negate(), at: T0 })).toThrow(InvalidWalletError);
  });
});

describe('Wallet movements', () => {
  test('debit returns a balanced entry and bumps version once', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(move('80.00'));
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('20.00');
    expect(entry.isBalanced()).toBe(true);
    expect(entry.walletVersion).toBe(2);
  });

  test('credit returns a balanced entry and bumps version once', () => {
    const wallet = openWallet('20.00');
    const entry = wallet.credit(move('5.50'));
    expect(wallet.balance.amount).toBe('25.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('debit of the whole balance leaves zero', () => {
    const wallet = openWallet('80.00');
    wallet.debit(move('80.00'));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('balance never goes negative: insufficient debit throws and changes nothing', () => {
    const wallet = openWallet('20.00');
    expect(wallet.canDebit(brl('80.00'))).toBe(false);
    expect(() => wallet.debit(move('80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(1);
  });

  test('zero amount movements are rejected and do not bump version', () => {
    const wallet = openWallet('20.00');
    expect(() => wallet.credit(move('0.00'))).toThrow(InvalidLedgerEntryError);
    expect(wallet.version).toBe(1);
  });

  test('operation currency must match the wallet currency', () => {
    const wallet = openWallet('20.00');
    expect(() => wallet.credit({ ...move('1.00'), money: usd('1.00') })).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit({ ...move('1.00'), money: usd('1.00') })).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('balance equals the sum of its ledger entries', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: brl('100.00'),
      at: T0,
      opening: { transactionId: 'o', ledgerEntryId: 'lo' },
    });
    const entries = [openingEntry!, wallet.debit(move('30.00', 1)), wallet.credit(move('12.25', 2)), wallet.debit(move('0.25', 3))];
    const rebuilt = entries.reduce((sum, e) => sum.add(e.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(4);
  });

  test('rehydrate restores state without validation', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('7.00'),
      version: 9,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.version).toBe(9);
    expect(wallet.balance.amount).toBe('7.00');
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'le',
    walletId: 'w',
    transactionId: 't',
    direction: LedgerDirection.Debit,
    money: brl('10.00'),
    balanceBefore: brl('50.00'),
    balanceAfter: brl('40.00'),
    walletVersion: 2,
    createdAt: T0,
  };

  test('accepts balanced arithmetic', () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
  });

  test('rejects unbalanced arithmetic', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('41.00') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a negative resulting balance', () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl('5.00'), balanceAfter: brl('5.00').subtract(brl('10.00')) }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a non-positive wallet version', () => {
    expect(() => WalletLedgerEntry.create({ ...base, walletVersion: 0 })).toThrow(InvalidLedgerEntryError);
  });

  test('rejects mixed currencies', () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: usd('10.00') })).toThrow(CurrencyMismatchError);
  });

  test('has no mutable fields or transition methods', () => {
    const entry = WalletLedgerEntry.create(base);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['isBalanced', 'signedAmount']);
  });

  test('is frozen at runtime', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl('0.00');
    }).toThrow(TypeError);
  });
});
