import type { SQL } from 'bun';
import { expect } from 'bun:test';
import type { Instance } from './cluster';

export interface WalletRef {
  id: string;
  playerId: string;
}

export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export async function createWallet(instance: Instance, amount: string): Promise<WalletRef> {
  const response = await fetch(`${instance.url}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: brl(amount) }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as WalletRef;
}

export function wager(wallet: WalletRef, kind: string, amount: string, extra: Record<string, string> = {}) {
  const externalTransactionId = extra['externalTransactionId'] ?? `tx-${crypto.randomUUID()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    ...extra,
  };
}

export type Wager = ReturnType<typeof wager>;

export interface SubmitResult {
  status: number;
  body: { transactionId: string; status: string; balance?: { amount: string }; idempotentReplay: boolean; failureCode?: string };
}

export async function submit(instance: Instance, body: Wager): Promise<SubmitResult> {
  const response = await fetch(`${instance.url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `${body.providerId}:${body.externalTransactionId}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as SubmitResult['body'] };
}

/**
 * A provider's at-least-once client: resend the same request (same Idempotency-Key) on connection errors or 503
 * until a final answer arrives, rotating over whichever instances are alive.
 */
export async function submitUntilAnswered(instances: () => Instance[], body: Wager, timeoutMs = 60_000): Promise<SubmitResult> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    const live = instances();
    const target = live[attempt++ % Math.max(1, live.length)];
    if (target) {
      try {
        const result = await submit(target, body);
        if (result.status !== 503) return result;
      } catch {
        // instance down or killed mid-request: retry elsewhere
      }
    }
    await Bun.sleep(100);
  }
  throw new Error(`no final answer for ${body.externalTransactionId}`);
}

export function queueMessage(body: Wager, messageId = `msg-${crypto.randomUUID()}`) {
  const { providerId, externalTransactionId } = body;
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: `${providerId}:${externalTransactionId}` },
  };
}

/** challenge §13 final invariant, checked through the public API: wallet.balance == balance rebuilt from the ledger. */
export async function expectReconciled(instance: Instance, walletIds: string[]): Promise<void> {
  for (const walletId of walletIds) {
    const response = await fetch(`${instance.url}/wallets/${walletId}/reconciliation`, { method: 'POST' });
    const report = (await response.json()) as { consistent: boolean };
    expect(report.consistent).toBe(true);
  }
}

export async function ledgerCount(sql: SQL, walletId: string, direction: 'DEBIT' | 'CREDIT'): Promise<number> {
  const [row] = await sql`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = ${direction}`;
  return row.n;
}

export async function balanceOf(sql: SQL, walletId: string): Promise<string> {
  const [row] = await sql`select balance::text as b from wallets where id = ${walletId}`;
  return row.b;
}
