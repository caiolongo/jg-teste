import { createHash } from 'node:crypto';
import type { MoneyProps } from '../money/money';

/** Business fields covered by the idempotency hash. Transport data (headers, messageId, idempotencyKey) is excluded. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** Normalized via Money (scale 2), so "25" and "25.00" hash the same. */
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** JSON with object keys sorted recursively and undefined fields dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): Json {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined) {
        out[key] = canonicalize(field);
      }
    }
    return out;
  }
  return value as Json;
}

/** sha256 hex of the canonical JSON of the business fields. */
export function computePayloadHash(fields: WagerPayloadFields): string {
  const subset: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(subset)).digest('hex');
}
