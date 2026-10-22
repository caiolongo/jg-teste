import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_USER: z.string().min(1),
  DATABASE_PASSWORD: z.string().min(1),
  DATABASE_NAME: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Max wait for a wallet row lock before the request fails as transient (503 / queue retry). */
  LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  AWS_REGION: z.string().min(1),
  AWS_ENDPOINT: z.url(),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_WAGER_QUEUE_URL: z.url(),
  SQS_WAGER_DLQ_URL: z.url(),
  SQS_EVENTS_QUEUE_URL: z.url(),

  SQS_CONSUMER_ENABLED: z.stringbool().default(true),
  /** Parallel pollers per instance; FIFO keeps each wallet (message group) in order regardless. */
  SQS_CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  /** Transient retry: visibility = base · 2^(receiveCount−1), capped. */
  SQS_RETRY_BASE_SECONDS: z.coerce.number().int().min(0).default(5),
  SQS_RETRY_MAX_SECONDS: z.coerce.number().int().min(1).max(43_200).default(300),
  OUTBOX_RELAY_ENABLED: z.stringbool().default(true),
  /** Events claimed per publish round, sent as parallel SendMessageBatch calls of 10 (load test: 10 → 100 removed the outbox lag). */
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  /** Idle wait between rounds when the outbox had nothing due. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),

  PENDING_REFERENCE_WORKER_ENABLED: z.stringbool().default(true),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(1_000),
  /** Reference lookups before REJECTED / REFERENCE_NOT_FOUND (ARCHITECTURE.md §8): 8 lookups, 15 s·2^(n−1) apart (~32 min). */
  PENDING_REFERENCE_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  PENDING_REFERENCE_BASE_DELAY_MS: z.coerce.number().int().min(1).default(15_000),

  /** Fault injection for crash tests only (see src/infrastructure/fault-injection.ts). Unset in normal runs. */
  FAULT_KILL_AFTER_COMMIT_MESSAGE_IDS: z.string().optional(),
  FAULT_KILL_AFTER_PUBLISH: z.stringbool().default(false),

  /** Time given to in-flight messages on SIGTERM; keep below the container stop grace period (30 s). */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
});

export type Env = z.infer<typeof EnvSchema>;

/** Fails fast at boot: a misconfigured instance must not start taking traffic. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
