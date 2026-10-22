import type { EventPublisher, PublishReport } from '../application/ports/messaging';
import {
  type ProcessWagerCommand,
  type ProcessWagerOutcome,
  ProcessWagerTransaction,
} from '../application/wagering/process-wager-transaction';
import type { OutboxMessage } from '../domain/messaging/outbox-message';

/**
 * Fault injection for the multi-process crash tests (challenge §13, scenarios 5, 6 and 8). Wired by the composition
 * root ONLY when a FAULT_* variable is set; never enabled in normal runs. SIGKILL cannot be caught: the process
 * dies on the spot, exactly like a crash or an OOM kill, with no shutdown hooks and no chance to ack or commit.
 */
function killSelf(): never {
  process.kill(process.pid, 'SIGKILL');
  throw new Error('unreachable');
}

/** Dies right after the SQL commit and before the consumer acks, for the listed queue messageIds. */
export class CrashAfterCommitProcessWager extends ProcessWagerTransaction {
  private messageIds = new Set<string>();

  withVictims(messageIds: Iterable<string>): this {
    this.messageIds = new Set(messageIds);
    return this;
  }

  override async execute(command: ProcessWagerCommand): Promise<ProcessWagerOutcome> {
    const outcome = await super.execute(command);
    if (command.inbox && this.messageIds.has(command.inbox.messageId)) killSelf();
    return outcome;
  }
}

/** Dies after the broker accepted a batch and before the outbox rows are marked published (before COMMIT). */
export class CrashAfterPublishPublisher implements EventPublisher {
  constructor(private readonly inner: EventPublisher) {}

  async publish(messages: OutboxMessage[]): Promise<PublishReport> {
    const report = await this.inner.publish(messages);
    if (report.published.length > 0) killSelf();
    return report;
  }
}
