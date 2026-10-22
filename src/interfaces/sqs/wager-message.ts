import { z } from 'zod';
import { SUBMITTABLE_KINDS } from '../../domain/wager/wager-transaction';

const id = z.string().trim().min(1).max(128);

/** Envelope of `wager-transactions.fifo` (challenge §10). */
export const WagerTransactionRequestedMessage = z.object({
  messageId: id,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.object({
    providerId: id,
    externalTransactionId: id,
    idempotencyKey: z.string().regex(/^[\x21-\x7e]{1,255}$/),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: id,
    gameId: id,
    kind: z.enum(SUBMITTABLE_KINDS.map((k) => k as string) as [string, ...string[]]),
    money: z.object({ amount: z.string(), currency: z.string() }),
    referenceExternalTransactionId: id.optional(),
  }),
});

export type WagerTransactionRequested = z.infer<typeof WagerTransactionRequestedMessage>;
