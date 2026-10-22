import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { expectSqlError, resetTestDatabase, testSql } from '../support/database';

const UNIQUE = '23505';
const CHECK = '23514';
const FK = '23503';
const INTEGRITY = '23000';
const HASH = 'a'.repeat(64);
const T = '2026-07-29T15:00:00Z';

let sql: SQL;

beforeAll(async () => {
  await resetTestDatabase();
  sql = testSql();
});

afterAll(async () => {
  await sql.close();
});

const uuid = () => crypto.randomUUID();

interface TxRow {
  id?: string;
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  status?: string;
  externalId?: string;
  providerId?: string;
  idempotencyKey?: string;
  referenceExternalId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  currency?: string;
  roundId?: string;
}

/** Inserts a transaction row; defaults describe a valid PENDING BET. */
async function insertTx(db: SQL, row: TxRow): Promise<string> {
  const id = row.id ?? uuid();
  const status = row.status ?? 'PENDING';
  const externalId = row.externalId ?? `ext-${id}`;
  const providerId = row.providerId ?? 'provider-a';
  await db`
    insert into wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
      round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
      status, failure_code, processed_at, next_reference_attempt_at, created_at, updated_at
    ) values (
      ${id}, ${providerId}, ${externalId}, ${row.idempotencyKey ?? `${providerId}:${externalId}`}, ${HASH},
      ${row.walletId}, ${row.playerId}, ${row.roundId ?? 'round-1'}, 'fortune-chimp', ${row.kind}, ${row.amount},
      ${row.currency ?? 'BRL'}, ${row.referenceExternalId ?? null}, ${row.referenceTransactionId ?? null},
      ${status}, ${row.failureCode ?? null},
      ${status === 'PROCESSED' ? T : null}, ${status === 'PENDING_REFERENCE' ? T : null}, ${T}, ${T}
    )`;
  return id;
}

async function insertLedger(
  db: SQL,
  e: { walletId: string; transactionId: string; direction: string; amount: string; before: string; after: string; version: number; currency?: string },
): Promise<void> {
  await db`
    insert into wallet_ledger_entries (
      id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at
    ) values (
      ${uuid()}, ${e.walletId}, ${e.transactionId}, ${e.direction}, ${e.amount}, ${e.currency ?? 'BRL'},
      ${e.before}, ${e.after}, ${e.version}, ${T}
    )`;
}

/** Opens a wallet the way the application will: wallet + OPENING transaction + CREDIT entry, one SQL transaction. */
async function openWallet(balance = '100.00', currency = 'BRL'): Promise<{ walletId: string; playerId: string }> {
  const walletId = uuid();
  const playerId = uuid();
  await sql.begin(async (tx) => {
    await tx`
      insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
      values (${walletId}, ${playerId}, ${currency}, ${balance}, 1, ${T}, ${T})`;
    if (balance !== '0.00') {
      const openingId = await insertTx(tx, {
        walletId, playerId, kind: 'OPENING', amount: balance, status: 'PROCESSED', providerId: 'internal', currency,
      });
      await insertLedger(tx, { walletId, transactionId: openingId, direction: 'CREDIT', amount: balance, before: '0.00', after: balance, version: 1, currency });
    }
  });
  return { walletId, playerId };
}

/** Applies a debit the way the application will: tx row, wallet update and entry in one SQL transaction. */
async function debit(w: { walletId: string; playerId: string }, amount: string, before: string, after: string, version: number) {
  const txId = uuid();
  await sql.begin(async (tx) => {
    await insertTx(tx, { ...w, id: txId, kind: 'BET', amount, status: 'PROCESSED' });
    await tx`update wallets set balance = ${after}, version = ${version}, updated_at = ${T} where id = ${w.walletId}`;
    await insertLedger(tx, { ...w, transactionId: txId, direction: 'DEBIT', amount, before, after, version });
  });
  return txId;
}

describe('migrations', () => {
  test('create every table', async () => {
    const rows = await sql`
      select table_name from information_schema.tables where table_schema = 'public' order by table_name`;
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
      'inbox_messages',
      'mikro_orm_migrations',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);
  });
});

describe('wallets', () => {
  test('one wallet per player and currency', async () => {
    const { playerId } = await openWallet('0.00');
    const err = await expectSqlError(
      () => sql`insert into wallets values (${uuid()}, ${playerId}, 'BRL', 0, 1, ${T}, ${T})`,
    );
    expect(err.state).toBe(UNIQUE);
    // the same player may hold another currency
    await sql`insert into wallets values (${uuid()}, ${playerId}, 'USD', 0, 1, ${T}, ${T})`;
  });

  test('balance cannot be negative', async () => {
    const err = await expectSqlError(() => sql`insert into wallets values (${uuid()}, ${uuid()}, 'BRL', -0.01, 1, ${T}, ${T})`);
    expect(err.state).toBe(CHECK);
  });

  test('currency must be an ISO-4217 code', async () => {
    const err = await expectSqlError(() => sql`insert into wallets values (${uuid()}, ${uuid()}, 'brl', 0, 1, ${T}, ${T})`);
    expect(err.state).toBe(CHECK);
  });

  test('amounts are exact NUMERIC(20,2), never floats', async () => {
    const rows = await sql`select (0.10::numeric(20,2) + 0.20::numeric(20,2))::text as v`;
    expect(rows[0].v).toBe('0.30');
    const err = await expectSqlError(() => sql`select ${'1234567890123456789.00'}::numeric(20,2)`);
    expect(err.state).toBe('22003');
  });

  test('a new wallet starts at version 1', async () => {
    const err = await expectSqlError(() => sql`insert into wallets values (${uuid()}, ${uuid()}, 'BRL', 0, 2, ${T}, ${T})`);
    expect(err.state).toBe(INTEGRITY);
  });

  test('a positive opening balance needs its ledger entry (checked at commit)', async () => {
    const err = await expectSqlError(() =>
      sql.begin(async (tx) => {
        await tx`insert into wallets values (${uuid()}, ${uuid()}, 'BRL', 100, 1, ${T}, ${T})`;
      }),
    );
    expect(err.state).toBe(INTEGRITY);
    expect(err.message).toContain('no matching ledger entry');
  });

  test('balance cannot change without its ledger entry', async () => {
    const w = await openWallet('100.00');
    const err = await expectSqlError(() =>
      sql.begin(async (tx) => {
        await tx`update wallets set balance = 50, version = 2 where id = ${w.walletId}`;
      }),
    );
    expect(err.state).toBe(INTEGRITY);
  });

  test('version moves exactly with the balance', async () => {
    const w = await openWallet('100.00');
    const skip = await expectSqlError(() => sql`update wallets set balance = 50, version = 3 where id = ${w.walletId}`);
    expect(skip.message).toContain('without incrementing version');
    const noBalance = await expectSqlError(() => sql`update wallets set version = 2 where id = ${w.walletId}`);
    expect(noBalance.message).toContain('without a balance change');
  });

  test('identity is immutable and wallets are never deleted', async () => {
    const w = await openWallet('0.00');
    expect((await expectSqlError(() => sql`update wallets set currency = 'USD' where id = ${w.walletId}`)).state).toBe(INTEGRITY);
    expect((await expectSqlError(() => sql`delete from wallets where id = ${w.walletId}`)).state).toBe(INTEGRITY);
  });

  test('a balance change with its entry commits', async () => {
    const w = await openWallet('100.00');
    await debit(w, '80.00', '100.00', '20.00', 2);
    const [row] = await sql`select balance::text, version from wallets where id = ${w.walletId}`;
    expect(row).toEqual({ balance: '20.00', version: 2 });
  });
});

describe('wager_transactions', () => {
  test('idempotency key is unique', async () => {
    const w = await openWallet('0.00');
    await insertTx(sql, { ...w, kind: 'BET', amount: '1.00', idempotencyKey: 'dup-key' });
    const err = await expectSqlError(() => insertTx(sql, { ...w, kind: 'BET', amount: '1.00', idempotencyKey: 'dup-key' }));
    expect(err.state).toBe(UNIQUE);
  });

  test('(provider, external id) is unique', async () => {
    const w = await openWallet('0.00');
    await insertTx(sql, { ...w, kind: 'BET', amount: '1.00', externalId: 'ext-dup', idempotencyKey: 'k1' });
    const err = await expectSqlError(() =>
      insertTx(sql, { ...w, kind: 'BET', amount: '1.00', externalId: 'ext-dup', idempotencyKey: 'k2' }),
    );
    expect(err.state).toBe(UNIQUE);
    await insertTx(sql, { ...w, kind: 'BET', amount: '1.00', externalId: 'ext-dup', providerId: 'provider-b' });
  });

  test.each([
    ['REFUND without reference', { kind: 'REFUND', amount: '1.00' }],
    ['ROLLBACK without reference', { kind: 'ROLLBACK', amount: '1.00' }],
    ['BET with reference', { kind: 'BET', amount: '1.00', referenceExternalId: 'x' }],
    ['zero BET', { kind: 'BET', amount: '0.00' }],
    ['negative amount', { kind: 'LOSS', amount: '-1.00' }],
    ['unknown kind', { kind: 'JACKPOT', amount: '1.00' }],
    ['unknown status', { kind: 'BET', amount: '1.00', status: 'DONE' }],
    ['REJECTED without failure code', { kind: 'BET', amount: '1.00', status: 'REJECTED' }],
    ['PENDING with failure code', { kind: 'BET', amount: '1.00', failureCode: 'INSUFFICIENT_FUNDS' }],
  ])('rejects %s', async (_name, row) => {
    const w = await openWallet('0.00');
    const err = await expectSqlError(() => insertTx(sql, { ...w, ...row }));
    expect(err.state).toBe(CHECK);
  });

  test('LOSS may be zero', async () => {
    const w = await openWallet('0.00');
    await insertTx(sql, { ...w, kind: 'LOSS', amount: '0.00' });
  });

  test('wallet must exist', async () => {
    const err = await expectSqlError(() => insertTx(sql, { walletId: uuid(), playerId: uuid(), kind: 'BET', amount: '1.00' }));
    expect(err.state).toBe(FK);
  });

  test('a reference is reversed at most once in total (REFUND or ROLLBACK)', async () => {
    const w = await openWallet('100.00');
    const betId = await debit(w, '10.00', '100.00', '90.00', 2);
    await insertTx(sql, { ...w, kind: 'REFUND', amount: '10.00', status: 'PROCESSED', referenceExternalId: 'b', referenceTransactionId: betId });
    const err = await expectSqlError(() =>
      insertTx(sql, { ...w, kind: 'ROLLBACK', amount: '10.00', status: 'PROCESSED', referenceExternalId: 'b', referenceTransactionId: betId }),
    );
    expect(err.state).toBe(UNIQUE);
    // rejected reversals stay auditable and do not count
    await insertTx(sql, {
      ...w, kind: 'REFUND', amount: '10.00', status: 'REJECTED', failureCode: 'ALREADY_REVERSED', referenceExternalId: 'b',
    });
  });

  test('terminal statuses are final', async () => {
    const w = await openWallet('0.00');
    const id = await insertTx(sql, { ...w, kind: 'BET', amount: '1.00', status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    const err = await expectSqlError(
      () => sql`update wager_transactions set status = 'PENDING', failure_code = null where id = ${id}`,
    );
    expect(err.state).toBe(INTEGRITY);
    expect(err.message).toContain('terminal');
  });

  test('business fields are immutable while pending', async () => {
    const w = await openWallet('0.00');
    const id = await insertTx(sql, { ...w, kind: 'BET', amount: '1.00' });
    const err = await expectSqlError(() => sql`update wager_transactions set amount = 2 where id = ${id}`);
    expect(err.message).toContain('immutable');
    // a legal transition is allowed
    await sql`
      update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS', updated_at = now()
      where id = ${id}`;
  });

  test('PENDING_REFERENCE cannot go back to PENDING, and rows are never deleted', async () => {
    const w = await openWallet('0.00');
    const id = await insertTx(sql, { ...w, kind: 'ROLLBACK', amount: '1.00', status: 'PENDING_REFERENCE', referenceExternalId: 'late' });
    const back = await expectSqlError(
      () => sql`update wager_transactions set status = 'PENDING', next_reference_attempt_at = null where id = ${id}`,
    );
    expect(back.state).toBe(INTEGRITY);
    expect((await expectSqlError(() => sql`delete from wager_transactions where id = ${id}`)).state).toBe(INTEGRITY);
  });
});

describe('wallet_ledger_entries', () => {
  test('is append-only: no update, delete or truncate', async () => {
    await openWallet('100.00');
    expect((await expectSqlError(() => sql`update wallet_ledger_entries set amount = 1`)).state).toBe(INTEGRITY);
    expect((await expectSqlError(() => sql`delete from wallet_ledger_entries`)).state).toBe(INTEGRITY);
    expect((await expectSqlError(() => sql`truncate wallet_ledger_entries cascade`)).state).toBe(INTEGRITY);
  });

  test('arithmetic must balance and results cannot be negative', async () => {
    const w = await openWallet('100.00');
    const txId = await insertTx(sql, { ...w, kind: 'BET', amount: '10.00' });
    const unbalanced = await expectSqlError(() =>
      sql.begin((tx) => insertLedger(tx, { ...w, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '95.00', version: 2 })),
    );
    expect(unbalanced.state).toBe(CHECK);
    const negative = await expectSqlError(() =>
      sql.begin((tx) => insertLedger(tx, { ...w, transactionId: txId, direction: 'DEBIT', amount: '110.00', before: '100.00', after: '-10.00', version: 2 })),
    );
    expect(negative.state).toBe(CHECK);
  });

  test('one entry per transaction per wallet', async () => {
    const w = await openWallet('100.00');
    const betId = await debit(w, '10.00', '100.00', '90.00', 2);
    const err = await expectSqlError(() =>
      sql.begin(async (tx) => {
        await tx`update wallets set balance = 80, version = 3 where id = ${w.walletId}`;
        await insertLedger(tx, { ...w, transactionId: betId, direction: 'DEBIT', amount: '10.00', before: '90.00', after: '80.00', version: 3 });
      }),
    );
    expect(err.state).toBe(UNIQUE);
  });

  test('the chain cannot be broken', async () => {
    const w = await openWallet('100.00');
    const txId = await insertTx(sql, { ...w, kind: 'BET', amount: '10.00' });
    const err = await expectSqlError(() =>
      sql.begin(async (tx) => {
        await tx`update wallets set balance = 40, version = 2 where id = ${w.walletId}`;
        await insertLedger(tx, { ...w, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '50.00', after: '40.00', version: 2 });
      }),
    );
    expect(err.message).toContain('chain broken');
  });

  test('an entry must be reflected in the wallet (checked at commit)', async () => {
    const w = await openWallet('100.00');
    const txId = await insertTx(sql, { ...w, kind: 'BET', amount: '10.00' });
    const err = await expectSqlError(() =>
      sql.begin((tx) => insertLedger(tx, { ...w, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00', version: 2 })),
    );
    expect(err.message).toContain('not reflected');
  });

  test('entry currency must be the wallet currency', async () => {
    const w = await openWallet('100.00');
    const txId = await insertTx(sql, { ...w, kind: 'BET', amount: '10.00' });
    const err = await expectSqlError(() =>
      sql.begin(async (tx) => {
        await tx`update wallets set balance = 90, version = 2 where id = ${w.walletId}`;
        await insertLedger(tx, { ...w, transactionId: txId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00', version: 2, currency: 'USD' });
      }),
    );
    expect(err.state).toBe(FK);
  });

  test('entry must belong to its transaction wallet', async () => {
    const a = await openWallet('100.00');
    const b = await openWallet('100.00');
    const txOfA = await insertTx(sql, { ...a, kind: 'BET', amount: '10.00' });
    const err = await expectSqlError(() =>
      sql.begin(async (tx) => {
        await tx`update wallets set balance = 90, version = 2 where id = ${b.walletId}`;
        await insertLedger(tx, { ...b, transactionId: txOfA, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00', version: 2 });
      }),
    );
    expect(err.state).toBe(FK);
  });

  test('wallet balance equals the balance rebuilt from the ledger', async () => {
    const w = await openWallet('100.00');
    await debit(w, '30.00', '100.00', '70.00', 2);
    await debit(w, '0.50', '70.00', '69.50', 3);
    const [row] = await sql`
      select w.balance::text as stored,
             coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as rebuilt
        from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.id = ${w.walletId}
       group by w.balance`;
    expect(row).toEqual({ stored: '69.50', rebuilt: '69.50' });
  });
});

describe('inbox_messages and outbox_messages', () => {
  test('inbox deduplicates by (consumer, message id)', async () => {
    await sql`insert into inbox_messages values ('wager-consumer', 'msg-1', ${HASH}, ${T}, null)`;
    const err = await expectSqlError(() => sql`insert into inbox_messages values ('wager-consumer', 'msg-1', ${HASH}, ${T}, null)`);
    expect(err.state).toBe(UNIQUE);
    await sql`insert into inbox_messages values ('other-consumer', 'msg-1', ${HASH}, ${T}, null)`;
  });

  test('outbox ids are unique and a published row is not scheduled', async () => {
    const id = uuid();
    await sql`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
              values (${id}, 'agg', 'WalletBalanceChanged', ${{ a: 1 }}, ${T}, ${T})`;
    const dup = await expectSqlError(
      () => sql`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at) values (${id}, 'agg', 'X', '{}', ${T})`,
    );
    expect(dup.state).toBe(UNIQUE);
    const bad = await expectSqlError(
      () => sql`update outbox_messages set published_at = ${T} where id = ${id}`,
    );
    expect(bad.state).toBe(CHECK);
  });
});
