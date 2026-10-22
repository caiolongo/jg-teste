import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';
import { testEnv } from './database';

export function testSqsClient(): SQSClient {
  return createSqsClient(testEnv());
}

/** A dedicated FIFO queue + FIFO DLQ pair with its own redrive policy, so tests never share messages. */
export async function createTestQueues(sqs: SQSClient, options: { maxReceiveCount?: number; visibilityTimeout?: number } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `test-wager-dlq-${suffix}.fifo`, Attributes: fifo }));
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes?.['QueueArn'];
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `test-wager-${suffix}.fifo`,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(options.visibilityTimeout ?? 5),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(options.maxReceiveCount ?? 8) }),
      },
    }),
  );
  return { queueUrl: main.QueueUrl!, dlqUrl: dlq.QueueUrl! };
}

export async function sendRaw(sqs: SQSClient, queueUrl: string, body: string, groupId: string, dedupId = crypto.randomUUID()) {
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: dedupId }));
}

/** Visible + in-flight messages. */
export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
  const out = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(out.Attributes?.['ApproximateNumberOfMessages'] ?? 0) + Number(out.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? 0);
}

/** Reads (without deleting) what is in a queue, e.g. the DLQ, with message attributes. */
export async function peek(sqs: SQSClient, queueUrl: string, max = 10): Promise<Message[]> {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: 1,
      VisibilityTimeout: 0,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return out.Messages ?? [];
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

/** A dedicated standard queue standing in for `wagering-events`. */
export async function createEventsQueue(sqs: SQSClient): Promise<string> {
  const out = await sqs.send(new CreateQueueCommand({ QueueName: `test-events-${crypto.randomUUID().slice(0, 8)}` }));
  return out.QueueUrl!;
}

/** Receives and deletes everything currently in the queue. */
export async function drain(sqs: SQSClient, queueUrl: string): Promise<{ eventId: string; body: Record<string, unknown> }[]> {
  const received: { eventId: string; body: Record<string, unknown> }[] = [];
  for (;;) {
    const out = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
    );
    const messages = out.Messages ?? [];
    if (messages.length === 0) return received;
    for (const m of messages) {
      received.push({ eventId: m.MessageAttributes?.['eventId']?.StringValue ?? '', body: JSON.parse(m.Body ?? '{}') });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
}
