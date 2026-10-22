import { z } from 'zod';
import { SUBMITTABLE_KINDS } from '../../domain/wager/wager-transaction';
import { RequestValidationError } from './http-errors';

/** Shape only; Money.from enforces the decimal rules (scale, sign, notation) in the domain. */
const MoneySchema = z.object({
  amount: z.string(),
  currency: z.string(),
});

const id = z.string().trim().min(1).max(128);

export const CreateWalletBody = z.object({
  playerId: z.uuid(),
  initialBalance: MoneySchema,
});

export const WagerTransactionBody = z.object({
  providerId: id,
  externalTransactionId: id,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: id,
  gameId: id,
  // OPENING is internal and therefore not accepted here.
  kind: z.enum(SUBMITTABLE_KINDS.map((k) => k as string) as [string, ...string[]]),
  money: MoneySchema,
  referenceExternalTransactionId: id.optional(),
});

export const UuidParam = z.uuid();

export const LedgerQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Visible ASCII only: keys travel in headers and logs. */
export const IdempotencyKeyHeader = z.string().regex(/^[\x21-\x7e]{1,255}$/);

export function parse<T extends z.ZodType>(schema: T, value: unknown, code = 'INVALID_PAYLOAD'): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(
      code,
      'request does not match the contract',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
