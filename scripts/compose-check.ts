/**
 * Smoke check against the real Docker Compose deployment with three replicas:
 *
 *   docker compose up -d --build --scale app=3 --wait
 *   bun run test:compose
 *
 * Talks only to the public HTTP API of the replicas on ports 3000–3002 and exits non-zero on any failure.
 */
const urls = (process.env['COMPOSE_URLS'] ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002').split(',');
const at = (i: number) => urls[i % urls.length]!;
const brl = (amount: string) => ({ amount, currency: 'BRL' });

function check(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
  console.log(`ok    ${message}`);
}

async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function createWallet(amount: string) {
  return (await json(`${at(0)}/wallets`, { method: 'POST', body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: brl(amount) }) })).body;
}

function bet(wallet: Record<string, any>, amount: string) {
  return { providerId: 'compose-check', externalTransactionId: `tx-${crypto.randomUUID()}`, playerId: wallet['playerId'], walletId: wallet['id'], roundId: 'r', gameId: 'g', kind: 'BET', money: brl(amount) };
}

const submit = (url: string, body: ReturnType<typeof bet>) =>
  json(`${url}/wagering/transactions`, { method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': `${body.providerId}:${body.externalTransactionId}` } });

for (const url of urls) check((await fetch(`${url}/health/ready`)).status === 200, `${url} ready`);

const w1 = await createWallet('100.00');
const [a, b] = await Promise.all([submit(at(0), bet(w1, '80.00')), submit(at(1), bet(w1, '80.00'))]);
check([a.status, b.status].sort().join() === '200,422', '§8: two 80.00 bets on 100.00 via two replicas → one 200, one 422');
check((await json(`${at(2)}/wallets/${w1['id']}`)).body['balance'].amount === '20.00', '§8: balance 20.00');

const w2 = await createWallet('100.00');
const same = bet(w2, '10.00');
const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(at(i), same)));
check(new Set(results.map((r) => r.body['transactionId'])).size === 1, 'same bet ×50 across 3 replicas → one transaction');
check(results.filter((r) => !r.body['idempotentReplay']).length === 1, 'same bet ×50 → 49 idempotent replays');

for (const wallet of [w1, w2]) {
  const report = (await json(`${at(1)}/wallets/${wallet['id']}/reconciliation`, { method: 'POST' })).body;
  check(report['consistent'] === true, `wallet ${wallet['id']} reconciles (balance == ledger)`);
}
console.log('compose check passed');

export {};
