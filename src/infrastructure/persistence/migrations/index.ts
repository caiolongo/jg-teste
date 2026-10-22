import type { Constructor } from '@mikro-orm/core';
import type { Migration } from '@mikro-orm/migrations';
import { Migration20261021000001CreateFinancialTables } from './Migration20261021000001CreateFinancialTables';
import { Migration20261021000002CreateMessagingTables } from './Migration20261021000002CreateMessagingTables';
import { Migration20261021000003CreateIntegrityTriggers } from './Migration20261021000003CreateIntegrityTriggers';

/** Ordered list of schema migrations. Append new ones; never edit or reorder applied ones. */
export const migrations: Constructor<Migration>[] = [
  Migration20261021000001CreateFinancialTables,
  Migration20261021000002CreateMessagingTables,
  Migration20261021000003CreateIntegrityTriggers,
];
