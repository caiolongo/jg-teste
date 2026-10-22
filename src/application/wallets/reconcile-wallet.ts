import type { MoneyProps } from '../../domain/money/money';
import { WalletNotFoundError } from '../errors';
import type { UnitOfWork } from '../ports/repositories';
import type { AppLogger, Metrics } from '../ports/system';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compares the materialized balance with the balance rebuilt from the ledger.
 * Divergences are reported, logged and counted — never corrected silently.
 */
export class ReconcileWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string, correlationId: string): Promise<ReconciliationReport> {
    const report = await this.uow.run(async (repos) => {
      // Locked so the stored balance and the ledger sum are read from the same moment, not across a commit.
      const wallet = await repos.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(`wallet ${walletId} not found`);
      const summary = await repos.ledger.summarize(wallet.id, wallet.currency);
      const difference = wallet.balance.subtract(summary.calculatedBalance);
      return {
        walletId: wallet.id,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: summary.calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: summary.entries,
      };
    });

    if (!report.consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error('wallet balance diverges from ledger', {
        walletId,
        correlationId,
        difference: report.difference.amount,
        checkedEntries: report.checkedEntries,
      });
    }
    return report;
  }
}
