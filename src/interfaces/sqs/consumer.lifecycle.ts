import type { BeforeApplicationShutdown, OnApplicationBootstrap } from '@nestjs/common';
import type { WagerQueueConsumer } from './wager-queue-consumer';

/**
 * Starts the consumer once the app is up and stops it on SIGTERM. `beforeApplicationShutdown` runs before
 * the ORM closes its pool (onApplicationShutdown), so in-flight messages can still commit and be acked.
 */
export class ConsumerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    private readonly consumer: WagerQueueConsumer,
    private readonly enabled: boolean,
  ) {}

  onApplicationBootstrap(): void {
    if (this.enabled) this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
  }
}
