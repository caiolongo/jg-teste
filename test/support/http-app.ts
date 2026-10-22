import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../src/app.module';
import { loadEnv } from '../../src/config/env';
import { TEST_DATABASE } from './database';

export interface TestApp {
  app: INestApplication;
  url: string;
  close(): Promise<void>;
}

/** Boots the real Nest app (real Postgres, real modules) on a random port. */
export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const env = loadEnv({ ...process.env, DATABASE_NAME: TEST_DATABASE, LOG_LEVEL: 'silent', SQS_CONSUMER_ENABLED: 'false', OUTBOX_RELAY_ENABLED: 'false', PENDING_REFERENCE_WORKER_ENABLED: 'false', ...overrides });
  const app = await NestFactory.create(AppModule.register(env), { logger: false });
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}`, close: () => app.close() };
}
