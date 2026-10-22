import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { AppLogger } from '../../application/ports/system';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';

export interface PendingReferenceWorkerOptions {
  enabled: boolean;
  pollIntervalMs: number;
  /** Upper bound of retries per round, so one round never runs unbounded. */
  maxPerRound: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scheduled retry of PENDING_REFERENCE transactions (challenge §7.1), running in every instance.
 * Each retry claims one due row with SKIP LOCKED in its own SQL transaction, so N workers share the
 * backlog without a global lock; the backoff and the give-up rule live in the domain (markPendingReference).
 */
export class PendingReferenceWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly logger: AppLogger,
    private readonly options: PendingReferenceWorkerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.enabled) this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info('pending reference worker started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loop;
    this.logger.info('pending reference worker stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let retried = 0;
      try {
        while (this.running && retried < this.options.maxPerRound && (await this.processWager.retryNextPendingReference())) {
          retried += 1;
        }
      } catch (error) {
        // Transient failures (lock timeout, DB down) are retried on the next round; the row stays due.
        this.logger.warn('pending reference round failed', { error: error instanceof Error ? error.message : 'unknown' });
      }
      if (this.running && retried < this.options.maxPerRound) await sleep(this.options.pollIntervalMs);
    }
  }
}
