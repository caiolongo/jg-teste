import type { LedgerDirection, WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import type { MoneyProps } from '../domain/money/money';
import type { FailureCode } from '../domain/wager/failure-code';
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager/wager-transaction';
import { TransactionNotFoundError, WalletNotFoundError } from './errors';
import type { UnitOfWork } from './ports/repositories';
import { toWalletView, type WalletView } from './wallets/create-wallet';

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  entries: LedgerEntryView[];
  /** walletVersion to continue after; the HTTP layer turns it into an opaque cursor. */
  nextAfterVersion: number | undefined;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId: string | undefined;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  balance: MoneyProps | undefined;
  createdAt: string;
  processedAt: string | undefined;
}

const toLedgerEntryView = (e: WalletLedgerEntry): LedgerEntryView => ({
  id: e.id,
  transactionId: e.transactionId,
  direction: e.direction,
  money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(),
  balanceAfter: e.balanceAfter.toJSON(),
  walletVersion: e.walletVersion,
  createdAt: e.createdAt.toISOString(),
});

const toTransactionView = (t: WagerTransaction): TransactionView => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  status: t.status,
  referenceExternalTransactionId: t.referenceExternalTransactionId,
  referenceTransactionId: t.referenceTransactionId,
  failureCode: t.failureCode,
  balance: t.resultBalance?.toJSON(),
  createdAt: t.createdAt.toISOString(),
  processedAt: t.processedAt?.toISOString(),
});

/** Read side for the GET endpoints. Reads run in a short transaction without locks. */
export class WageringQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run((r) => r.wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(`wallet ${walletId} not found`);
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, options: { afterVersion?: number | undefined; limit: number }): Promise<LedgerPageView> {
    return this.uow.run(async (r) => {
      if (!(await r.wallets.findById(walletId))) throw new WalletNotFoundError(`wallet ${walletId} not found`);
      const page = await r.ledger.listByWallet(walletId, options);
      return { entries: page.entries.map(toLedgerEntryView), nextAfterVersion: page.nextAfterVersion };
    });
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const tx = await this.uow.run((r) => r.transactions.findById(transactionId));
    if (!tx) throw new TransactionNotFoundError(`transaction ${transactionId} not found`);
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.uow.run((r) => r.transactions.findByProviderAndExternalId(providerId, externalTransactionId));
    if (!tx) throw new TransactionNotFoundError(`transaction ${providerId}/${externalTransactionId} not found`);
    return toTransactionView(tx);
  }
}
