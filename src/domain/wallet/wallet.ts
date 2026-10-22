import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { CurrencyMismatchError, InsufficientFundsError, InvalidWalletError } from '../shared/errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Required when initialBalance > 0: ids for the internal OPENING transaction and its ledger entry. */
  opening?: { transactionId: string; ledgerEntryId: string };
}

export interface WalletOpening {
  wallet: Wallet;
  /** CREDIT entry for the initial balance; undefined when the wallet opens at zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

/**
 * Aggregate root. The balance only changes through debit/credit, and each change returns
 * the ledger entry that explains it, so balance and ledger cannot drift apart.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** version starts at 1. A positive initial balance is booked as an OPENING credit from zero. */
  static open(props: OpenWalletProps): WalletOpening {
    const { initialBalance, opening, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError(`initial balance cannot be negative, got ${initialBalance}`);
    }
    if (initialBalance.isPositive() !== (opening !== undefined)) {
      throw new InvalidWalletError('opening ids must be given exactly when the initial balance is positive');
    }
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);
    const openingEntry = opening
      ? WalletLedgerEntry.create({
          id: opening.ledgerEntryId,
          walletId: wallet.id,
          transactionId: opening.transactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          walletVersion: wallet.version,
          createdAt: at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state as-is; does not re-validate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(`balance ${this._balance} cannot cover ${props.money}`);
    }
    return this.move(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.move(LedgerDirection.Credit, props);
  }

  private move(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(props.money) : balanceBefore.subtract(props.money);
    // The entry validates positive amount, non-negative result and arithmetic before any state changes.
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet ${this.id} holds ${this.currency}, operation is in ${money.currency}`);
    }
  }
}
