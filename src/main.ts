import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { createPinoLogger, NestPinoLogger } from './infrastructure/observability/pino-logger';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createPinoLogger(env.LOG_LEVEL);
  const app = await NestFactory.create(AppModule.register(env), { logger: new NestPinoLogger(logger) });
  // Lets Nest run onModuleDestroy / beforeApplicationShutdown hooks on SIGTERM (consumer drain, workers stop).
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  logger.info({ port: env.PORT }, 'wagering-processor listening');
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
