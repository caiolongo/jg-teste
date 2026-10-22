import { Money } from '../../../src/domain/money/money';
import { computePayloadHash } from '../../../src/domain/wager/payload-hash';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from '../../../src/domain/wager/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';

export const T0 = new Date('2026-07-29T15:00:00.000Z');
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

let seq = 0;
export const nextId = (prefix = 'id') => `${prefix}-${++seq}`;

export function openWallet(balance = '100.00', playerId = 'player-1'): Wallet {
  const initialBalance = brl(balance);
  return Wallet.open({
    id: 'wallet-1',
    playerId,
    initialBalance,
    at: T0,
    ...(initialBalance.isPositive() ? { opening: { transactionId: nextId('tx'), ledgerEntryId: nextId('le') } } : {}),
  }).wallet;
}

export function newTx(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId('ext');
  const base = {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    ...overrides,
  };
  return WagerTransaction.create({
    id: nextId('tx'),
    idempotencyKey: `${base.providerId}:${externalTransactionId}`,
    payloadHash: computePayloadHash({ ...base, money: base.money.toJSON() }),
    createdAt: T0,
    ...base,
  });
}
