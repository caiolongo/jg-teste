import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../src/domain/shared/errors';
import { brl, usd } from './fixtures';

describe('Money.from — parsing and scale', () => {
  test.each([
    ['25.00', '25.00'],
    ['25', '25.00'],
    ['25.5', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['999999999999999999.99', '999999999999999999.99'],
  ])('accepts %p and serializes with scale 2 as %p', (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e3'],
    ['1E-2'],
    [''],
    ['   '],
    ['10.005'],
    ['1.234'],
    ['-1.00'],
    ['+1.00'],
    [' 1.00'],
    ['1.00 '],
    ['01.00'],
    ['.50'],
    ['5.'],
    ['1,00'],
    ['0x10'],
    ['1000000000000000000.00'],
  ])('rejects %p', (input) => {
    expect(() => brl(input)).toThrow(InvalidMoneyError);
  });

  test('rejects a number instead of a decimal string', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each([['brl'], ['BR'], ['BRLX'], [''], ['12A']])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('never rounds: more than 2 decimals is an error, not a rounded value', () => {
    expect(() => brl('0.999')).toThrow(InvalidMoneyError);
    expect(() => brl('0.995')).toThrow(InvalidMoneyError);
  });
});

describe('Money — arithmetic', () => {
  test('is exact where floats are not (0.10 + 0.20)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('subtract can go negative internally and serializes the sign', () => {
    const result = brl('5.00').subtract(brl('10.10'));
    expect(result.amount).toBe('-5.10');
    expect(result.isNegative()).toBe(true);
  });

  test('negate flips the sign', () => {
    expect(brl('12.34').negate().amount).toBe('-12.34');
    expect(brl('12.34').negate().negate().equals(brl('12.34'))).toBe(true);
  });

  test('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.amount).toBe('10.00');
    expect(b.amount).toBe('11.00');
    expect(b).not.toBe(a);
  });

  test('predicates and comparisons', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(brl('1.00').equals(usd('1.00'))).toBe(false);
  });

  test('toString shows amount and currency', () => {
    expect(brl('975').toString()).toBe('975.00 BRL');
  });
});

describe('Money — currency conflicts', () => {
  test.each([
    ['add', (a: Money, b: Money) => a.add(b)],
    ['subtract', (a: Money, b: Money) => a.subtract(b)],
    ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
  ])('%s across currencies throws', (_name, op) => {
    expect(() => op(brl('1.00'), usd('1.00'))).toThrow(CurrencyMismatchError);
  });
});
