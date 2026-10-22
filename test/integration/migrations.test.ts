import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { resetTestDatabase, testEnv, testSql } from '../support/database';

let sql: SQL;
let orm: MikroORM;

beforeAll(async () => {
  await resetTestDatabase();
  sql = testSql();
  orm = await MikroORM.init(buildOrmConfig(testEnv()));
});

afterAll(async () => {
  await orm.close();
  await sql.close();
});

const objects = async () => {
  const tables = await sql`
    select table_name as name from information_schema.tables
     where table_schema = 'public' and table_name <> 'mikro_orm_migrations' order by 1`;
  const functions = await sql`
    select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' order by 1`;
  return { tables: tables.map((r: { name: string }) => r.name), functions: functions.map((r: { name: string }) => r.name) };
};

test('every migration is reversible: down to zero leaves nothing, up restores everything', async () => {
  const before = await objects();
  expect(before.tables).toHaveLength(5);
  expect(before.functions).toHaveLength(6);

  const reverted = await orm.migrator.down({ to: 0 });
  expect(reverted).toHaveLength(3);
  expect(await objects()).toEqual({ tables: [], functions: [] });

  const applied = await orm.migrator.up();
  expect(applied).toHaveLength(3);
  expect(await objects()).toEqual(before);
  expect(await orm.migrator.getPending()).toHaveLength(0);
});
