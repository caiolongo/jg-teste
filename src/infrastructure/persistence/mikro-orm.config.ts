import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { Env } from '../../config/env';
import { migrations } from './migrations';
import { persistenceSchemas } from './schemas';

export function buildOrmConfig(env: Env) {
  return defineConfig({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    dbName: env.DATABASE_NAME,
    pool: { min: 1, max: env.DATABASE_POOL_MAX },
    // Persistence schemas are registered explicitly (EntitySchema, no decorators, no folder scanning).
    entities: persistenceSchemas,
    extensions: [Migrator],
    migrations: {
      // Classes listed in code: works the same under `bun run`, in Docker and in tests.
      migrationsList: migrations,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    // The schema is owned by migrations; the ORM never alters it on its own.
    ensureDatabase: false,
    debug: false,
  });
}
