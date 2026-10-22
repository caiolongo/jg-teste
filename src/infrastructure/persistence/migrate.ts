import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../config/env';
import { buildOrmConfig } from './mikro-orm.config';

/** Usage: bun run src/infrastructure/persistence/migrate.ts <up|down|pending> */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const orm = await MikroORM.init(buildOrmConfig(loadEnv()));
  try {
    const migrator = orm.migrator;
    if (command === 'up') {
      const applied = await migrator.up();
      console.log(`migrations applied: ${applied.map((m) => m.name).join(', ') || 'none'}`);
    } else if (command === 'down') {
      const reverted = await migrator.down();
      console.log(`migrations reverted: ${reverted.map((m) => m.name).join(', ') || 'none'}`);
    } else if (command === 'pending') {
      const pending = await migrator.getPending();
      console.log(`pending migrations: ${pending.map((m) => m.name).join(', ') || 'none'}`);
    } else {
      throw new Error(`unknown command "${command}" (expected up, down or pending)`);
    }
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
