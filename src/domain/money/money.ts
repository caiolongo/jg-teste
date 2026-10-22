import { CurrencyMismatchError, InvalidMoneyError } from '../shared/errors';

/** Contract shape: amount is always a decimal string with scale 2, e.g. "25.00". */
export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const UNITS_PER_MAJOR = 100n;
/** NUMERIC(20,2) holds 18 integer digits; larger values would overflow the column. */
const MAX_INTEGER_DIGITS = 18;
/** Plain non-negative decimal, at most 2 places: no sign, exponent, spaces or leading zeros. */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value. Stored as integer minor units (bigint), so arithmetic is exact:
 * no floats are involved at any point, and nothing is ever rounded.
 */
export class Money {
  private constructor(
    private readonly units: bigint,
    public readonly currency: string,
  ) {}

  /** Parses an input contract. Rejects negatives, more than 2 decimals and any non-plain notation. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('money must be an object with amount and currency');
    }
    const { amount, currency } = props;
    Money.assertCurrency(currency);
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`invalid amount "${amount}": expected a non-negative decimal with up to ${SCALE} places`);
    }
    const [integerPart = '0', fractionPart = ''] = amount.split('.');
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(`amount "${amount}" exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    const units = BigInt(integerPart) * UNITS_PER_MAJOR + BigInt(fractionPart.padEnd(SCALE, '0'));
    return new Money(units, currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.units + other.units, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.units - other.units, this.currency);
  }

  negate(): Money {
    return new Money(-this.units, this.currency);
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.units < other.units;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.units === other.units;
  }

  /** Always 2 decimal places, e.g. "975.00" or "-5.10". */
  get amount(): string {
    const sign = this.units < 0n ? '-' : '';
    const abs = this.units < 0n ? -this.units : this.units;
    const fraction = (abs % UNITS_PER_MAJOR).toString().padStart(SCALE, '0');
    return `${sign}${abs / UNITS_PER_MAJOR}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${String(currency)}": expected an ISO-4217 code`);
    }
  }
}
