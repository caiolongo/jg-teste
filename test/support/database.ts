import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { type Env, loadEnv } from '../../src/config/env';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

export const TEST_DATABASE = process.env['TEST_DATABASE_NAME'] ?? 'wagering_test';

export function testEnv(): Env {
  return loadEnv({ ...process.env, DATABASE_NAME: TEST_DATABASE });
}

function connect(env: Env, database: string): SQL {
  return new SQL({
    hostname: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    username: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database,
    max: 10,
  });
}

/** Creates the test database if missing, then rebuilds the schema through every migration's down and up. */
export async function resetTestDatabase(): Promise<void> {
  const env = testEnv();
  const admin = connect(env, env.DATABASE_USER);
  try {
    const exists = await admin`select 1 from pg_database where datname = ${TEST_DATABASE}`;
    if (exists.length === 0) {
      await admin.unsafe(`create database "${TEST_DATABASE}"`);
    }
  } finally {
    await admin.close();
  }
  const orm = await MikroORM.init(buildOrmConfig(env));
  try {
    await orm.migrator.down({ to: 0 });
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
}

/** Raw SQL client on the test database, for asserting schema behaviour without the ORM. */
export function testSql(): SQL {
  const env = testEnv();
  return connect(env, TEST_DATABASE);
}

/** SQLSTATE of a Postgres error (e.g. 23505 unique_violation), or undefined. */
export function sqlState(error: unknown): string | undefined {
  if (error && typeof error === 'object') {
    const e = error as { errno?: unknown; code?: unknown };
    if (typeof e.errno === 'string') return e.errno;
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  }
  return undefined;
}

/** Runs fn and returns the SQLSTATE and message it failed with; fails the test if it succeeds. */
export async function expectSqlError(fn: () => Promise<unknown>): Promise<{ state: string | undefined; message: string }> {
  try {
    await fn();
  } catch (error) {
    return { state: sqlState(error), message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error('expected the statement to fail, but it succeeded');
}
