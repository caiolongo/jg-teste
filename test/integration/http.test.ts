import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resetTestDatabase } from '../support/database';
import { startTestApp, type TestApp } from '../support/http-app';

let server: TestApp;

beforeAll(async () => {
  await resetTestDatabase();
  server = await startTestApp();
});

afterAll(async () => {
  await server.close();
});

const uuid = () => crypto.randomUUID();
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
}

async function createWallet(amount = '1000.00') {
  const playerId = uuid();
  const res = await call('POST', '/wallets', { playerId, initialBalance: brl(amount) });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

function wager(wallet: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `transaction-${uuid()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    ...extra,
  };
}

const submit = (body: { providerId: string; externalTransactionId: string }, key = `${body.providerId}:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', body, { 'idempotency-key': key });

describe('POST /wallets', () => {
  test('creates the wallet with the contract shape', async () => {
    const playerId = uuid();
    const res = await call('POST', '/wallets', { playerId, initialBalance: brl('1000.00') });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: brl('1000.00'), version: 1 });
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });

  test('duplicate player + currency → 409', async () => {
    const wallet = await createWallet();
    const res = await call('POST', '/wallets', { playerId: wallet.playerId, initialBalance: brl('1.00') });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    ['non-uuid player', { playerId: 'x', initialBalance: brl('1.00') }, 'INVALID_PAYLOAD'],
    ['number amount', { playerId: crypto.randomUUID(), initialBalance: { amount: 10, currency: 'BRL' } }, 'INVALID_PAYLOAD'],
    ['3 decimals', { playerId: crypto.randomUUID(), initialBalance: brl('1.001') }, 'INVALID_MONEY'],
    ['negative', { playerId: crypto.randomUUID(), initialBalance: brl('-1.00') }, 'INVALID_MONEY'],
    ['scientific', { playerId: crypto.randomUUID(), initialBalance: brl('1e3') }, 'INVALID_MONEY'],
  ])('%s → 400', async (_name, body, code) => {
    const res = await call('POST', '/wallets', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
  });

  test('malformed JSON → 400', async () => {
    const res = await call('POST', '/wallets', '{"playerId":');
    expect(res.status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('PROCESSED → 200 with the contract shape', async () => {
    const wallet = await createWallet('1000.00');
    const res = await submit(wager(wallet, 'BET', '25.00'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
  });

  test('identical retry → same status and body with idempotentReplay: true', async () => {
    const wallet = await createWallet('1000.00');
    const body = wager(wallet, 'BET', '25.00');
    const first = await submit(body);
    const replay = await submit(body);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('same key, different payload → 409 IDEMPOTENCY_CONFLICT', async () => {
    const wallet = await createWallet('1000.00');
    const body = wager(wallet, 'BET', '25.00');
    await submit(body);
    const res = await submit({ ...body, money: brl('30.00') } as typeof body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', details: { existingTransactionId: expect.any(String) } });
  });

  test('business rejection → 422 with failureCode and providerAction', async () => {
    const wallet = await createWallet('10.00');
    const res = await submit(wager(wallet, 'BET', '25.00'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      providerAction: 'DO_NOT_RETRY',
      balance: brl('10.00'),
    });
  });

  test('reference not yet known → 202 PENDING_REFERENCE', async () => {
    const wallet = await createWallet('100.00');
    const res = await submit(wager(wallet, 'ROLLBACK', '10.00', { referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect(res.body.balance).toBeUndefined();
  });

  test('missing or malformed Idempotency-Key → 400', async () => {
    const wallet = await createWallet();
    const missing = await call('POST', '/wagering/transactions', wager(wallet, 'BET', '1.00'));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    const spaced = await call('POST', '/wagering/transactions', wager(wallet, 'BET', '1.00'), { 'idempotency-key': 'has space' });
    expect(spaced.status).toBe(400);
  });

  test.each([
    ['OPENING kind', { kind: 'OPENING' }],
    ['unknown kind', { kind: 'JACKPOT' }],
    ['REFUND without reference', { kind: 'REFUND' }],
    ['zero BET', { money: { amount: '0.00', currency: 'BRL' } }],
    ['float amount', { money: { amount: 25.5, currency: 'BRL' } }],
  ])('%s → 400', async (_name, override) => {
    const wallet = await createWallet();
    const res = await submit({ ...wager(wallet, 'BET', '1.00'), ...override });
    expect(res.status).toBe(400);
  });

  test('unknown wallet → 404', async () => {
    const wallet = await createWallet();
    const res = await submit(wager({ id: uuid(), playerId: wallet.playerId }, 'BET', '1.00'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});

describe('queries', () => {
  test('GET wallet, transaction by id and by provider external id', async () => {
    const wallet = await createWallet('100.00');
    const body = wager(wallet, 'BET', '40.00');
    const { body: result } = await submit(body);

    expect((await call('GET', `/wallets/${wallet.id}`)).body).toMatchObject({ balance: brl('60.00'), version: 2 });
    const byId = await call('GET', `/wagering/transactions/${result.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ id: result.transactionId, kind: 'BET', status: 'PROCESSED', money: brl('40.00'), balance: brl('60.00') });
    const byExternal = await call('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExternal.body.id).toBe(result.transactionId);
  });

  test('404s are consistent', async () => {
    expect((await call('GET', `/wallets/${uuid()}`)).body.error.code).toBe('WALLET_NOT_FOUND');
    expect((await call('GET', `/wagering/transactions/${uuid()}`)).body.error.code).toBe('TRANSACTION_NOT_FOUND');
    expect((await call('GET', '/providers/provider-a/wagering/transactions/nope')).status).toBe(404);
    expect((await call('GET', '/wallets/not-a-uuid')).status).toBe(400);
    expect((await call('GET', '/no-such-route')).status).toBe(404);
  });

  test('ledger pages with a stable opaque cursor', async () => {
    const wallet = await createWallet('100.00');
    for (let i = 0; i < 4; i++) await submit(wager(wallet, 'BET', '1.00'));
    const first = await call('GET', `/wallets/${wallet.id}/ledger?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.entries.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([1, 2]);
    expect(first.body.entries[0]).toMatchObject({ direction: 'CREDIT', money: brl('100.00'), balanceBefore: brl('0.00') });
    // an entry appended between pages does not shift the next page
    await submit(wager(wallet, 'WIN', '3.00'));
    const second = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.entries.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([3, 4]);
    const third = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.entries.map((e: { walletVersion: number }) => e.walletVersion)).toEqual([5, 6]);
    expect(third.body.nextCursor).toBeNull();
    expect((await call('GET', `/wallets/${wallet.id}/ledger?cursor=garbage`)).body.error.code).toBe('INVALID_CURSOR');
    expect((await call('GET', `/wallets/${wallet.id}/ledger?limit=1000`)).status).toBe(400);
  });

  test('reconciliation returns the contract shape', async () => {
    const wallet = await createWallet('1000.00');
    await submit(wager(wallet, 'BET', '25.00'));
    const res = await call('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: brl('975.00'),
      calculatedBalance: brl('975.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('end to end over HTTP', () => {
  test('§8 scenario: two parallel 80.00 bets on 100.00', async () => {
    const wallet = await createWallet('100.00');
    const [a, b] = await Promise.all([submit(wager(wallet, 'BET', '80.00')), submit(wager(wallet, 'BET', '80.00'))]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect((await call('GET', `/wallets/${wallet.id}`)).body.balance).toEqual(brl('20.00'));
    const ledger = await call('GET', `/wallets/${wallet.id}/ledger`);
    expect(ledger.body.entries.filter((e: { direction: string }) => e.direction === 'DEBIT')).toHaveLength(1);
    expect((await call('POST', `/wallets/${wallet.id}/reconciliation`)).body.consistent).toBe(true);
  });
});
