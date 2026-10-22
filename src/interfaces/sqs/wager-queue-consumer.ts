import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { AppLogger, Metrics } from '../../application/ports/system';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { LogContext } from '../../infrastructure/observability/log-context';
import { classifyProcessingError, retryDelaySeconds } from './error-classification';
import { type WagerTransactionRequested, WagerTransactionRequestedMessage } from './wager-message';

export interface WagerQueueConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  /** Inbox key namespace: dedup is per (consumerName, messageId). */
  consumerName: string;
  concurrency: number;
  waitTimeSeconds: number;
  maxMessages: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownTimeoutMs: number;
}

type HandleResult = 'acked' | 'dead-lettered' | 'retry-later';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Consumes `wager-transactions.fifo` through the same use case as HTTP.
 *
 * - ack (DeleteMessage) only after the use case returned, i.e. after the SQL commit;
 * - duplicates are absorbed by the persistent inbox inside the same SQL transaction;
 * - failures follow ARCHITECTURE.md §10: permanent → DLQ now, transient → visibility backoff, bounded by maxReceiveCount;
 * - messages of one FIFO group (one wallet) are handled in order; different groups run in parallel;
 * - stop(): no new receives, in-flight messages finish, received-but-unstarted ones are released.
 */
export class WagerQueueConsumer {
  private running = false;
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];

  constructor(
    private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerTransaction,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly options: WagerQueueConsumerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = Array.from({ length: this.options.concurrency }, (_, i) => this.poll(i));
    this.logger.info('wager consumer started', { consumerName: this.options.consumerName, concurrency: this.options.concurrency });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const drained = await Promise.race([
      Promise.all(this.loops).then(() => true),
      sleep(this.options.shutdownTimeoutMs).then(() => false),
    ]);
    this.logger.info('wager consumer stopped', { consumerName: this.options.consumerName, drained });
  }

  private async poll(worker: number): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        const out = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.options.queueUrl,
            MaxNumberOfMessages: this.options.maxMessages,
            WaitTimeSeconds: this.options.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = out.Messages ?? [];
      } catch (error) {
        if (!this.running) break;
        this.logger.warn('receive failed; backing off', { worker, error: error instanceof Error ? error.message : 'unknown' });
        await sleep(1_000);
        continue;
      }
      await this.processBatch(messages);
    }
  }

  private async processBatch(messages: Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'unknown';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (let i = 0; i < group.length; i++) {
          const message = group[i]!;
          if (!this.running) {
            await this.release(message);
            continue;
          }
          const result = await this.handle(message);
          if (result === 'retry-later') {
            // Keep FIFO order within the wallet: the rest of this group waits for the failed message.
            await Promise.all(group.slice(i + 1).map((m) => this.release(m)));
            break;
          }
        }
      }),
    );
  }

  private async handle(message: Message): Promise<HandleResult> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let envelope: WagerTransactionRequested;
    try {
      envelope = WagerTransactionRequestedMessage.parse(JSON.parse(message.Body ?? ''));
    } catch (error) {
      return this.deadLetter(message, 'INVALID_MESSAGE', error, undefined);
    }

    return LogContext.run({ correlationId: envelope.messageId, messageId: envelope.messageId }, () =>
      this.process(message, envelope, receiveCount),
    );
  }

  private async process(message: Message, envelope: WagerTransactionRequested, receiveCount: number): Promise<HandleResult> {
    const log = {
      providerId: envelope.data.providerId,
      walletId: envelope.data.walletId,
      receiveCount,
    };
    try {
      const outcome = await this.processWager.execute({
        ...envelope.data,
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        inbox: { consumerName: this.options.consumerName, messageId: envelope.messageId },
      });
      // The SQL transaction has committed: only now is the message removed from the queue.
      await this.ack(message, log);
      if (outcome.type === 'result') {
        this.logger.info('message processed', { ...log, transactionId: outcome.result.transactionId, status: outcome.result.status });
      }
      return 'acked';
    } catch (error) {
      const failure = classifyProcessingError(error);
      if (failure.kind === 'permanent') {
        return this.deadLetter(message, failure.reason, error, log);
      }
      const delay = retryDelaySeconds(receiveCount, this.options.retryBaseSeconds, this.options.retryMaxSeconds);
      this.metrics.retryScheduled('sqs_consumer');
      this.logger.warn('message will be retried', {
        ...log,
        reason: failure.reason,
        retryInSeconds: delay,
        error: error instanceof Error ? error.message : 'unknown',
      });
      await this.changeVisibility(message, delay);
      return 'retry-later';
    }
  }

  private async ack(message: Message, log: Record<string, string | number | undefined>): Promise<void> {
    try {
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (error) {
      // Committed but not acked: the redelivery will be absorbed by the inbox.
      this.logger.warn('ack failed after commit; redelivery will be deduplicated', {
        ...log,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private async deadLetter(
    message: Message,
    reason: string,
    error: unknown,
    log: Record<string, string | number | undefined> | undefined,
  ): Promise<HandleResult> {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 256);
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.options.dlqUrl,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
          // Same original SQS id → a crash between send and delete does not duplicate within the dedup window.
          MessageDeduplicationId: message.MessageId,
          MessageAttributes: {
            errorCode: { DataType: 'String', StringValue: reason },
            errorDetail: { DataType: 'String', StringValue: detail || '-' },
            originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? '-' },
            receiveCount: { DataType: 'Number', StringValue: message.Attributes?.ApproximateReceiveCount ?? '1' },
          },
        }),
      );
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } catch (sendError) {
      // Not moved: it stays on the main queue and is retried, so it is never lost.
      this.logger.error('failed to dead-letter message; it will be redelivered', {
        ...log,
        reason,
        error: sendError instanceof Error ? sendError.message : 'unknown',
      });
      return 'retry-later';
    }
    this.metrics.deadLettered(reason);
    this.logger.error('message dead-lettered', { ...log, sqsMessageId: message.MessageId, reason });
    return 'dead-lettered';
  }

  private async release(message: Message): Promise<void> {
    await this.changeVisibility(message, 0);
  }

  private async changeVisibility(message: Message, seconds: number): Promise<void> {
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch {
      // The message becomes visible again when its current visibility timeout expires.
    }
  }
}
