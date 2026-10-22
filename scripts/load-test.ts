/**
 * Load test (`bun run test:load`) against the real deployment with three replicas:
 *
 *   docker compose up -d --build --scale app=3 --wait
 *   bun run test:load
 *
 * Closed-loop virtual users over HTTP + a queue burst over SQS. Client-side latency, server-side counters scraped from
 * /metrics, and the outbox lag measured in PostgreSQL (published_at − occurred_at). Ends by reconciling every wallet
 * touched. Raw results are written to docs/load-test/latest.md; the analysis lives in docs/LOAD_TEST.md.
 *
 * Tunables: LOAD_URLS, LOAD_VUS (50), LOAD_PHASE_SECONDS (30), LOAD_WALLETS (200), LOAD_QUEUE_MESSAGES (2000).
 */
import { SQL } from 'bun';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { cpus, platform, release, totalmem } from 'node:os';
import { loadEnv } from '../src/config/env';
import { createSqsClient } from '../src/infrastructure/messaging/sqs-client';

const env = loadEnv();
const URLS = (process.env['LOAD_URLS'] ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002').split(',');
const VUS = Number(process.env['LOAD_VUS'] ?? 50);
const PHASE_MS = Number(process.env['LOAD_PHASE_SECONDS'] ?? 30) * 1_000;
const WALLETS = Number(process.env['LOAD_WALLETS'] ?? 200);
const QUEUE_MESSAGES = Number(process.env['LOAD_QUEUE_MESSAGES'] ?? 2_000);

const sql = new SQL({
  hostname: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  username: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  database: env.DATABASE_NAME,
  max: 2,
});
const sqs = createSqsClient(env);

interface Wallet {
  id: string;
  playerId: string;
}
interface Sample {
  ms: number;
  status: number; // 0 = network error
  replay: boolean;
}

let rr = 0;
const nextUrl = () => URLS[rr++ % URLS.length]!;
const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;

// ---------------------------------------------------------------------------------------------- helpers

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function scrape(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (const url of URLS) {
    const text = await (await fetch(`${url}/metrics`)).text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('wagering_')) continue;
      const [series, value] = line.split(' ');
      const name = series!.replace(/\{.*$/, '');
      totals.set(name, (totals.get(name) ?? 0) + Number(value));
    }
  }
  return totals;
}

async function createWallet(amount: string): Promise<Wallet> {
  const response = await fetch(`${nextUrl()}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount, currency: 'BRL' } }),
  });
  if (response.status !== 201) throw new Error(`wallet creation failed: ${response.status}`);
  return (await response.json()) as Wallet;
}

function body(wallet: Wallet, kind: string, amount: string) {
  return {
    providerId: 'load',
    externalTransactionId: `load-${crypto.randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${crypto.randomUUID().slice(0, 8)}`,
    gameId: 'load-test',
    kind,
    money: { amount, currency: 'BRL' },
  };
}

async function submit(payload: ReturnType<typeof body>): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await fetch(`${nextUrl()}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `${payload.providerId}:${payload.externalTransactionId}` },
      body: JSON.stringify(payload),
    });
    const json = (await response.json()) as { idempotentReplay?: boolean };
    return { ms: performance.now() - started, status: response.status, replay: json.idempotentReplay === true };
  } catch {
    return { ms: performance.now() - started, status: 0, replay: false };
  }
}

/** Mix per operation: 70% BET, 20% WIN, 10% LOSS. */
function operation(wallet: Wallet) {
  const r = Math.random();
  if (r < 0.7) return body(wallet, 'BET', '1.00');
  if (r < 0.9) return body(wallet, 'WIN', '2.00');
  return body(wallet, 'LOSS', '0.00');
}

/** Outbox backlog and age of the oldest unpublished event, sampled during a phase. */
async function outboxSnapshot(): Promise<{ pending: number; oldestSeconds: number }> {
  const [row] = await sql`
    select count(*)::int as pending, coalesce(extract(epoch from now() - min(occurred_at)), 0)::float as oldest
      from outbox_messages where published_at is null`;
  return { pending: row.pending, oldestSeconds: row.oldest };
}

async function waitOutboxDrained(timeoutMs = 120_000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if ((await outboxSnapshot()).pending === 0) return performance.now() - started;
    await Bun.sleep(200);
  }
  throw new Error('outbox did not drain');
}

/** End-to-end delivery delay of the events created in [from, to): published_at − occurred_at. */
async function outboxDelay(from: Date, to: Date) {
  const [row] = await sql`
    select count(*)::int as events,
           coalesce(percentile_cont(0.5) within group (order by extract(epoch from published_at - occurred_at)), 0)::float as p50,
           coalesce(percentile_cont(0.95) within group (order by extract(epoch from published_at - occurred_at)), 0)::float as p95,
           coalesce(percentile_cont(0.99) within group (order by extract(epoch from published_at - occurred_at)), 0)::float as p99,
           coalesce(max(extract(epoch from published_at - occurred_at)), 0)::float as max
      from outbox_messages
     where occurred_at >= ${from} and occurred_at < ${to} and published_at is not null`;
  return row as { events: number; p50: number; p95: number; p99: number; max: number };
}

// ---------------------------------------------------------------------------------------------- phases

interface PhaseResult {
  name: string;
  description: string;
  durationS: number;
  requests: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
  replays: number;
  errorRate: number;
  lockConflicts: number;
  serverMeanMs: number;
  transientFailures: number;
  maxOutboxBacklog: number;
  maxOutboxAgeS: number;
  drainS: number;
  delivery: { events: number; p50: number; p95: number; p99: number; max: number };
}

async function runPhase(name: string, description: string, wallets: Wallet[], duplicateRatio: number): Promise<PhaseResult> {
  console.log(`\n▶ ${name}: ${description}`);
  const before = await scrape();
  const from = new Date();
  const samples: Sample[] = [];
  const deadline = performance.now() + PHASE_MS;
  let maxBacklog = 0;
  let maxAge = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const snapshot = await outboxSnapshot();
      maxBacklog = Math.max(maxBacklog, snapshot.pending);
      maxAge = Math.max(maxAge, snapshot.oldestSeconds);
      await Bun.sleep(500);
    }
  })();

  const started = performance.now();
  await Promise.all(
    Array.from({ length: VUS }, async () => {
      let last: ReturnType<typeof body> | undefined;
      while (performance.now() < deadline) {
        // A provider retry: same request, same Idempotency-Key.
        const payload = last && Math.random() < duplicateRatio ? last : operation(pick(wallets));
        samples.push(await submit(payload));
        last = payload;
      }
    }),
  );
  const elapsedS = (performance.now() - started) / 1_000;
  const to = new Date();
  const drainMs = await waitOutboxDrained();
  sampling = false;
  await sampler;
  const after = await scrape();

  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  // Errors: anything that is not a final business answer (2xx, or 422 business rejection).
  const errors = samples.filter((s) => !(s.status >= 200 && s.status < 300) && s.status !== 422).length;
  const delta = (metric: string) => (after.get(metric) ?? 0) - (before.get(metric) ?? 0);

  const result: PhaseResult = {
    name,
    description,
    durationS: elapsedS,
    requests: samples.length,
    throughput: samples.length / elapsedS,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? 0,
    statuses,
    replays: samples.filter((s) => s.replay).length,
    errorRate: errors / Math.max(1, samples.length),
    lockConflicts: delta('wagering_lock_conflicts_total'),
    serverMeanMs:
      (delta('wagering_processing_duration_seconds_sum') / Math.max(1, delta('wagering_processing_duration_seconds_count'))) * 1_000,
    transientFailures: statuses['503'] ?? 0,
    maxOutboxBacklog: maxBacklog,
    maxOutboxAgeS: maxAge,
    drainS: drainMs / 1_000,
    delivery: await outboxDelay(from, to),
  };
  console.log(
    `  ${result.requests} req · ${result.throughput.toFixed(0)} req/s · p50 ${result.p50.toFixed(1)} ms · p95 ${result.p95.toFixed(1)} ms · p99 ${result.p99.toFixed(1)} ms · errors ${(result.errorRate * 100).toFixed(2)}% · lock conflicts ${result.lockConflicts} · server mean ${result.serverMeanMs.toFixed(1)} ms · outbox p50 ${result.delivery.p50.toFixed(2)} s`,
  );
  return result;
}

interface QueueResult {
  messages: number;
  wallets: number;
  sendS: number;
  drainS: number;
  throughput: number;
  dlq: number;
}

async function runQueueBurst(wallets: Wallet[]): Promise<QueueResult> {
  console.log(`\n▶ queue burst: ${QUEUE_MESSAGES} messages over ${wallets.length} wallets (FIFO group = wallet)`);
  const before = await scrape();
  const messages = Array.from({ length: QUEUE_MESSAGES }, () => {
    const wallet = pick(wallets);
    const data = operation(wallet);
    return {
      group: wallet.id,
      body: JSON.stringify({
        messageId: `msg-${crypto.randomUUID()}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
      }),
    };
  });
  // Clock starts at the first send: consumers work while we are still sending, so this is end-to-end.
  const started = performance.now();
  // 20 concurrent senders, so the producer outruns the consumers and the drain time measures consumption.
  const batches = Array.from({ length: Math.ceil(messages.length / 10) }, (_, b) => messages.slice(b * 10, b * 10 + 10));
  let nextBatch = 0;
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++]!;
        await sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: env.SQS_WAGER_QUEUE_URL,
            Entries: batch.map((m, j) => ({ Id: String(j), MessageBody: m.body, MessageGroupId: m.group, MessageDeduplicationId: crypto.randomUUID() })),
          }),
        );
      }
    }),
  );
  const sendS = (performance.now() - started) / 1_000;
  const target = (before.get('wagering_transactions_total') ?? 0) + QUEUE_MESSAGES;
  while ((((await scrape()).get('wagering_transactions_total') ?? 0) < target) && performance.now() - started < 300_000) {
    await Bun.sleep(250);
  }
  const drainS = (performance.now() - started) / 1_000;
  const after = await scrape();
  const result = {
    messages: QUEUE_MESSAGES,
    wallets: wallets.length,
    sendS,
    drainS,
    throughput: QUEUE_MESSAGES / drainS,
    dlq: (after.get('wagering_dlq_messages_total') ?? 0) - (before.get('wagering_dlq_messages_total') ?? 0),
  };
  console.log(`  sent in ${sendS.toFixed(1)} s · all processed after ${drainS.toFixed(1)} s · ${result.throughput.toFixed(0)} msg/s · DLQ ${result.dlq}`);
  return result;
}

// ---------------------------------------------------------------------------------------------- main

for (const url of URLS) {
  if ((await fetch(`${url}/health/ready`).catch(() => undefined))?.status !== 200) {
    console.error(`${url} is not ready. Start the deployment first: docker compose up -d --build --scale app=3 --wait`);
    process.exit(1);
  }
}

console.log(`load test: ${URLS.length} instances · ${VUS} virtual users · ${PHASE_MS / 1_000} s per phase · ${WALLETS} wallets`);
const spread = await Promise.all(Array.from({ length: WALLETS }, () => createWallet('1000000.00')));
const hot = [await createWallet('1000000.00')];

const phases = [
  await runPhase('spread', `${VUS} VUs over ${WALLETS} wallets, 5% retries`, spread, 0.05),
  await runPhase('hot-wallet', `${VUS} VUs on a single wallet, 5% retries`, hot, 0.05),
  await runPhase('replay-storm', `${VUS} VUs over ${WALLETS} wallets, 50% retries`, spread, 0.5),
];
const queue = await runQueueBurst(spread);

console.log('\n▶ reconciling every wallet used');
let consistent = 0;
for (const wallet of [...spread, ...hot]) {
  const report = (await (await fetch(`${nextUrl()}/wallets/${wallet.id}/reconciliation`, { method: 'POST' })).json()) as { consistent: boolean };
  if (report.consistent) consistent += 1;
}
const walletsChecked = spread.length + hot.length;
console.log(`  ${consistent}/${walletsChecked} consistent`);

const [pg] = await sql`select version() as v`;
const ms = (n: number) => n.toFixed(1);
const report = `# Load test — raw results

Generated by \`bun run test:load\` on ${new Date().toISOString()}. Analysis: [LOAD_TEST.md](../LOAD_TEST.md).

## Environment

| | |
|---|---|
| Host | ${cpus()[0]?.model ?? 'unknown'} · ${cpus().length} cores · ${(totalmem() / 2 ** 30).toFixed(0)} GiB · ${platform()} ${release()} |
| Load generator | Bun ${Bun.version}, same host |
| Deployment | ${URLS.length} app replicas (Docker Compose), each with HTTP + SQS consumer + outbox relay + pending-reference worker, DB pool 10, outbox batch ${env.OUTBOX_BATCH_SIZE} |
| PostgreSQL | ${String(pg.v).split(' on ')[0]} (container) |
| SQS | LocalStack 4.14.0 (container) |

## HTTP phases (closed loop, ${VUS} virtual users, ${PHASE_MS / 1_000} s each)

| Phase | Requests | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Server mean (ms) | Error rate | Replays | Lock conflicts | 503 |
|---|---|---|---|---|---|---|---|---|---|---|---|
${phases
  .map(
    (p) =>
      `| ${p.name} | ${p.requests} | ${p.throughput.toFixed(0)} | ${ms(p.p50)} | ${ms(p.p95)} | ${ms(p.p99)} | ${ms(p.max)} | ${ms(p.serverMeanMs)} | ${(p.errorRate * 100).toFixed(2)}% | ${p.replays} | ${p.lockConflicts} | ${p.transientFailures} |`,
  )
  .join('\n')}

Status codes: ${phases.map((p) => `${p.name} ${JSON.stringify(p.statuses)}`).join(' · ')}

## Outbox lag

| Phase | Events | Delivery p50 (s) | p95 (s) | p99 (s) | max (s) | Max backlog | Oldest pending (s) | Drain after load (s) |
|---|---|---|---|---|---|---|---|---|
${phases
  .map(
    (p) =>
      `| ${p.name} | ${p.delivery.events} | ${p.delivery.p50.toFixed(2)} | ${p.delivery.p95.toFixed(2)} | ${p.delivery.p99.toFixed(2)} | ${p.delivery.max.toFixed(2)} | ${p.maxOutboxBacklog} | ${p.maxOutboxAgeS.toFixed(2)} | ${p.drainS.toFixed(2)} |`,
  )
  .join('\n')}

## Queue burst

Clock from the first send to the last message processed (consumers run while messages are still being sent).

| Messages | Wallets (FIFO groups) | Sending took (s) | First send → all processed (s) | Throughput (msg/s) | Dead-lettered |
|---|---|---|---|---|---|
| ${queue.messages} | ${queue.wallets} | ${queue.sendS.toFixed(1)} | ${queue.drainS.toFixed(1)} | ${queue.throughput.toFixed(0)} | ${queue.dlq} |

## Consistency after load

${consistent}/${walletsChecked} wallets reconcile (stored balance == balance rebuilt from the ledger).
`;
await Bun.write('docs/load-test/latest.md', report);
console.log('\nresults written to docs/load-test/latest.md');
await sql.close();
sqs.destroy();
process.exit(consistent === walletsChecked ? 0 : 1);
