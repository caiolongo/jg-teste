import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/core';
import type { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { UNIT_OF_WORK, type UnitOfWork } from './application/ports/repositories';
import {
  APP_LOGGER,
  type AppLogger,
  CLOCK,
  type Clock,
  ID_GENERATOR,
  type IdGenerator,
  METRICS,
  type Metrics,
} from './application/ports/system';
import { WageringQueries } from './application/queries';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { CreateWallet } from './application/wallets/create-wallet';
import { ReconcileWallet } from './application/wallets/reconcile-wallet';
import type { Env } from './config/env';
import { createPinoLogger, PinoAppLogger } from './infrastructure/observability/pino-logger';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { HealthController } from './interfaces/http/health.controller';
import { Readiness } from './interfaces/http/readiness';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { AuthGuard } from './interfaces/http/auth.guard';
import { CorrelationMiddleware } from './interfaces/http/correlation.middleware';
import { HttpErrorFilter } from './interfaces/http/error.filter';
import { WageringController } from './interfaces/http/wagering.controller';
import { WalletsController } from './interfaces/http/wallets.controller';
import { ConsumerLifecycle } from './interfaces/sqs/consumer.lifecycle';
import { WagerQueueConsumer } from './interfaces/sqs/wager-queue-consumer';
import { createSqsClient } from './infrastructure/messaging/sqs-client';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { PublishOutbox } from './application/messaging/publish-outbox';
import { EVENT_PUBLISHER, type EventPublisher } from './application/ports/messaging';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { OutboxRelay } from './interfaces/workers/outbox-relay';
import { CrashAfterCommitProcessWager, CrashAfterPublishPublisher } from './infrastructure/fault-injection';
import { PendingReferenceWorker } from './interfaces/workers/pending-reference-worker';

export const ENV = Symbol('ENV');
export const SQS_CLIENT = Symbol('SQSClient');
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

/**
 * Composition root. Application classes carry no Nest decorators: they are wired here by factory,
 * against ports, so the domain and use cases stay framework-free.
 */
@Module({})
export class AppModule implements NestModule {
  static register(env: Env): DynamicModule {
    const metrics = new PrometheusMetrics();
    return {
      module: AppModule,
      imports: [
        MikroOrmModule.forRoot({
          ...buildOrmConfig(env),
          // Each UnitOfWork.run forks its own EntityManager; no per-request context is needed.
          registerRequestContext: false,
        }),
      ],
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: ENV, useValue: env },
        { provide: CLOCK, useClass: SystemClock },
        { provide: ID_GENERATOR, useClass: UuidV7Generator },
        { provide: APP_LOGGER, useValue: new PinoAppLogger(createPinoLogger(env.LOG_LEVEL)) },
        { provide: PrometheusMetrics, useValue: metrics },
        { provide: METRICS, useExisting: PrometheusMetrics },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM) =>
            new MikroOrmUnitOfWork(orm as unknown as PostgresMikroORM, { lockTimeoutMs: env.LOCK_TIMEOUT_MS, metrics }),
          inject: [MikroORM],
        },
        {
          provide: CreateWallet,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, logger: AppLogger) => new CreateWallet(uow, ids, clock, logger),
          inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, APP_LOGGER],
        },
        {
          provide: ProcessWagerTransaction,
          useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock, logger: AppLogger, metrics: Metrics) => {
            const policy = { maxAttempts: env.PENDING_REFERENCE_MAX_ATTEMPTS, baseDelayMs: env.PENDING_REFERENCE_BASE_DELAY_MS };
            const victims = env.FAULT_KILL_AFTER_COMMIT_MESSAGE_IDS?.split(',').filter(Boolean);
            return victims?.length
              ? new CrashAfterCommitProcessWager(uow, ids, clock, logger, metrics, policy).withVictims(victims)
              : new ProcessWagerTransaction(uow, ids, clock, logger, metrics, policy);
          },
          inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, APP_LOGGER, METRICS],
        },
        {
          provide: ReconcileWallet,
          useFactory: (uow: UnitOfWork, logger: AppLogger, metrics: Metrics) => new ReconcileWallet(uow, logger, metrics),
          inject: [UNIT_OF_WORK, APP_LOGGER, METRICS],
        },
        {
          provide: WageringQueries,
          useFactory: (uow: UnitOfWork) => new WageringQueries(uow),
          inject: [UNIT_OF_WORK],
        },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(env) },
        {
          provide: WagerQueueConsumer,
          useFactory: (sqs: SQSClient, processWager: ProcessWagerTransaction, logger: AppLogger, metrics: Metrics) =>
            new WagerQueueConsumer(sqs, processWager, logger, metrics, {
              queueUrl: env.SQS_WAGER_QUEUE_URL,
              dlqUrl: env.SQS_WAGER_DLQ_URL,
              consumerName: WAGER_CONSUMER_NAME,
              concurrency: env.SQS_CONSUMER_CONCURRENCY,
              waitTimeSeconds: env.SQS_WAIT_TIME_SECONDS,
              maxMessages: 10,
              retryBaseSeconds: env.SQS_RETRY_BASE_SECONDS,
              retryMaxSeconds: env.SQS_RETRY_MAX_SECONDS,
              shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
            }),
          inject: [SQS_CLIENT, ProcessWagerTransaction, APP_LOGGER, METRICS],
        },
        {
          provide: ConsumerLifecycle,
          useFactory: (consumer: WagerQueueConsumer) => new ConsumerLifecycle(consumer, env.SQS_CONSUMER_ENABLED),
          inject: [WagerQueueConsumer],
        },
        {
          provide: EVENT_PUBLISHER,
          useFactory: (sqs: SQSClient) => {
            const publisher = new SqsEventPublisher(sqs, env.SQS_EVENTS_QUEUE_URL);
            return env.FAULT_KILL_AFTER_PUBLISH ? new CrashAfterPublishPublisher(publisher) : publisher;
          },
          inject: [SQS_CLIENT],
        },
        {
          provide: PublishOutbox,
          useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, logger: AppLogger, metrics: Metrics) =>
            new PublishOutbox(uow, publisher, clock, logger, metrics, env.OUTBOX_BATCH_SIZE),
          inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, APP_LOGGER, METRICS],
        },
        {
          provide: OutboxRelay,
          useFactory: (publishOutbox: PublishOutbox, logger: AppLogger) =>
            new OutboxRelay(publishOutbox, logger, {
              enabled: env.OUTBOX_RELAY_ENABLED,
              batchSize: env.OUTBOX_BATCH_SIZE,
              pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
              backlogEveryMs: 5_000,
            }),
          inject: [PublishOutbox, APP_LOGGER],
        },
        {
          provide: PendingReferenceWorker,
          useFactory: (processWager: ProcessWagerTransaction, logger: AppLogger) =>
            new PendingReferenceWorker(processWager, logger, {
              enabled: env.PENDING_REFERENCE_WORKER_ENABLED,
              pollIntervalMs: env.PENDING_REFERENCE_POLL_INTERVAL_MS,
              maxPerRound: 100,
            }),
          inject: [ProcessWagerTransaction, APP_LOGGER],
        },
        {
          provide: Readiness,
          useFactory: (orm: MikroORM, sqs: SQSClient) =>
            new Readiness({
              postgres: async () => {
                await (orm as unknown as PostgresMikroORM).em.fork().execute('select 1');
              },
              sqs: async () => {
                await sqs.send(new GetQueueAttributesCommand({ QueueUrl: env.SQS_WAGER_QUEUE_URL, AttributeNames: ['QueueArn'] }));
              },
            }),
          inject: [MikroORM, SQS_CLIENT],
        },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
