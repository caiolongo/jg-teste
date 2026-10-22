import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { TransientInfrastructureError } from '../../src/application/errors';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { resetTestDatabase, testEnv, testSql } from '../support/database';
import { RecordingMetrics } from '../support/fakes';
import { startTestApp, type TestApp } from '../support/http-app';

let server: TestApp;

beforeAll(async () => {
  await resetTestDatabase();
  server = await startTestApp();
});

afterAll(async () => {
  await server.close();
});

const get = (path: string, base = server.url) => fetch(`${base}${path}`);

describe('health checks', () => {
  test('liveness and readiness are open and report dependencies', async () => {
    const live = await get('/health/live');
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });

    const ready = await get('/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok', ready: true, shuttingDown: false, checks: { postgres: 'up', sqs: 'up' } });
  });

  test('readiness is 503 when SQS is unreachable, while liveness stays 200', async () => {
    const broken = await startTestApp({ AWS_ENDPOINT: 'http://127.0.0.1:1' });
    try {
      const ready = await get('/health/ready', broken.url);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
      expect((await get('/health/live', broken.url)).status).toBe(200);
    } finally {
      await broken.close();
    }
  });
});

describe('metrics endpoint', () => {
  test('exposes business, HTTP and process metrics in Prometheus format', async () => {
    const playerId = crypto.randomUUID();
    const wallet = await (
      await fetch(`${server.url}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
      })
    ).json() as { id: string };
    const body = {
      providerId: 'p',
      externalTransactionId: `tx-${crypto.randomUUID()}`,
      playerId,
      walletId: wallet.id,
      roundId: 'r',
      gameId: 'g',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    for (let i = 0; i < 2; i++) {
      await fetch(`${server.url}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `p:${body.externalTransactionId}` },
        body: JSON.stringify(body),
      });
    }

    const response = await get('/metrics');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('wagering_transactions_total{status="PROCESSED",kind="BET"} 1');
    expect(text).toContain('wagering_duplicates_detected_total{source="idempotency_replay"} 1');
    expect(text).toMatch(/wagering_processing_duration_seconds_count\{outcome="PROCESSED"\} 2/);
    expect(text).toContain('route="/wagering/transactions"');
    expect(text).toContain('process_cpu_user_seconds_total');
  });
});

describe('correlation id', () => {
  test('is echoed back, and assigned even when the body fails to parse before any middleware', async () => {
    const supplied = await fetch(`${server.url}/health/live`, { headers: { 'x-correlation-id': 'abc-123' } });
    expect(supplied.headers.get('x-correlation-id')).toBe('abc-123');
    const malformed = await fetch(`${server.url}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': 'bad-json-1' },
      body: '{"playerId":',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('x-correlation-id')).toBe('bad-json-1');
  });
});

describe('lock conflict metric', () => {
  test('a wallet lock timeout is counted', async () => {
    const orm = await MikroORM.init(buildOrmConfig(testEnv()));
    const sql = testSql();
    const metrics = new RecordingMetrics();
    const uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 100, metrics });
    try {
      const [wallet] = await sql`
        insert into wallets values (${crypto.randomUUID()}, ${crypto.randomUUID()}, 'BRL', 0, 1, now(), now()) returning id`;
      const holder = sql.begin(async (tx) => {
        await tx`select id from wallets where id = ${wallet.id} for update`;
        await Bun.sleep(400);
      });
      await Bun.sleep(50);
      await expect(uow.run((r) => r.wallets.findByIdForUpdate(wallet.id))).rejects.toBeInstanceOf(TransientInfrastructureError);
      await holder;
      expect(metrics.calls.find((c) => c.name === 'lockConflict')?.args).toEqual(['lock_timeout']);
    } finally {
      await orm.close();
      await sql.close();
    }
  });
});
