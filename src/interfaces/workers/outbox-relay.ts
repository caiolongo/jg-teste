import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { PublishOutbox } from '../../application/messaging/publish-outbox';
import type { AppLogger } from '../../application/ports/system';

export interface OutboxRelayOptions {
  enabled: boolean;
  batchSize: number;
  pollIntervalMs: number;
  /** How often the backlog (outbox lag) gauge is refreshed. */
  backlogEveryMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Background loop running in every instance. A full batch means more may be waiting, so it loops at once;
 * otherwise it idles for `pollIntervalMs`. Failures never stop the loop. On shutdown the current round finishes.
 */
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly publishOutbox: PublishOutbox,
    private readonly logger: AppLogger,
    private readonly options: OutboxRelayOptions,
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
    this.logger.info('outbox relay started', { batchSize: this.options.batchSize });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loop;
    this.logger.info('outbox relay stopped');
  }

  private async run(): Promise<void> {
    let lastBacklogAt = 0;
    while (this.running) {
      let fullBatch = false;
      try {
        const round = await this.publishOutbox.publishDueBatch();
        fullBatch = round.claimed === this.options.batchSize && round.failed === 0;
        if (Date.now() - lastBacklogAt >= this.options.backlogEveryMs) {
          lastBacklogAt = Date.now();
          await this.publishOutbox.measureBacklog();
        }
      } catch (error) {
        this.logger.warn('outbox relay round failed', { error: error instanceof Error ? error.message : 'unknown' });
      }
      if (!fullBatch && this.running) await sleep(this.options.pollIntervalMs);
    }
  }
}
