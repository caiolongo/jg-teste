import { SQSClient } from '@aws-sdk/client-sqs';
import type { Env } from '../../config/env';

export function createSqsClient(env: Env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
    // The app handles retries itself (visibility backoff, outbox retry); keep SDK retries short.
    maxAttempts: 2,
  });
}
