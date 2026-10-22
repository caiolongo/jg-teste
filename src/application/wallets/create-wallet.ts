import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletAlreadyExistsError } from '../errors';
import type { UnitOfWork } from '../ports/repositories';
import type { AppLogger, Clock, IdGenerator } from '../ports/system';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

/**
 * Opens a wallet. A positive initial balance is booked, in the same SQL transaction, as an internal
 * OPENING transaction with its CREDIT ledger entry and its events in the outbox.
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
  ) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.clock.now();
    const opening = initialBalance.isPositive() ? { transactionId: this.ids.next(), ledgerEntryId: this.ids.next() } : undefined;
    const { wallet, openingEntry } = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      at,
      ...(opening ? { opening } : {}),
    });

    await this.uow.run(async (repos) => {
      if (!(await repos.wallets.insertIfAbsent(wallet))) {
        throw new WalletAlreadyExistsError(`player ${command.playerId} already has a ${initialBalance.currency} wallet`);
      }
      if (opening && openingEntry) {
        const openingTx = WagerTransaction.createOpening({
          id: opening.transactionId,
          walletId: wallet.id,
          playerId: wallet.playerId,
          money: initialBalance,
          at,
        });
        await repos.transactions.insertIfAbsent(openingTx);
        await repos.ledger.append(openingEntry);
        const ctx = (eventId: string) => ({ eventId, correlationId: command.correlationId, occurredAt: at });
        await repos.outbox.addAll([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(openingTx, ctx(this.ids.next()))),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx(this.ids.next()))),
        ]);
      }
    });

    this.logger.info('wallet created', { walletId: wallet.id, correlationId: command.correlationId, version: wallet.version });
    return toWalletView(wallet);
  }
}
