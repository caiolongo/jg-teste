import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishReport } from '../../application/ports/messaging';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

const SQS_BATCH_LIMIT = 10;

/**
 * Publishes outbox envelopes to the `wagering-events` standard queue (ARCHITECTURE.md §11).
 * The eventId travels as a message attribute (and inside the body), so consumers deduplicate redeliveries.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  /** SQS takes at most 10 entries per batch: a larger claim goes out as parallel batches of 10. */
  async publish(messages: OutboxMessage[]): Promise<PublishReport> {
    const chunks: OutboxMessage[][] = [];
    for (let i = 0; i < messages.length; i += SQS_BATCH_LIMIT) chunks.push(messages.slice(i, i + SQS_BATCH_LIMIT));
    const reports = await Promise.all(chunks.map((chunk) => this.publishBatch(chunk)));
    return {
      published: reports.flatMap((r) => r.published),
      failed: reports.flatMap((r) => r.failed),
    };
  }

  private async publishBatch(messages: OutboxMessage[]): Promise<PublishReport> {
    try {
      const out = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.queueUrl,
          Entries: messages.map((m, index) => ({
            Id: String(index),
            MessageBody: JSON.stringify(m.payload),
            MessageAttributes: {
              eventId: { DataType: 'String', StringValue: m.id },
              eventType: { DataType: 'String', StringValue: m.eventType },
              aggregateId: { DataType: 'String', StringValue: m.aggregateId },
            },
          })),
        }),
      );
      const byIndex = (entryId: string | undefined) => messages[Number(entryId)]!.id;
      return {
        published: (out.Successful ?? []).map((s) => byIndex(s.Id)),
        failed: (out.Failed ?? []).map((f) => ({ id: byIndex(f.Id), reason: `${f.Code ?? 'error'}: ${f.Message ?? ''}`.slice(0, 500) })),
      };
    } catch (error) {
      const reason = (error instanceof Error ? `${error.name}: ${error.message}` : 'publish failed').slice(0, 500);
      return { published: [], failed: messages.map((m) => ({ id: m.id, reason })) };
    }
  }
}
