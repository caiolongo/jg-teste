import { invertDirection, LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../shared/errors';
import { FailureCode } from './failure-code';
import { computePayloadHash } from './payload-hash';

export enum WagerTransactionKind {
  /** Internal: credit of a wallet's initial balance. Never accepted from the API or the queue. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

/** Kinds a provider may submit. */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Retry budget for transactions waiting on a reference that has not arrived yet. */
export interface PendingReferencePolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

/** 8 attempts, delays 15s·2^(n-1): the last attempt happens ~32 min after the first. */
export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = { maxAttempts: 8, baseDelayMs: 15_000 };

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** Balance observed when the transaction was resolved; returned on idempotent replays. */
  resultBalance?: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date | undefined;
  updatedAt: Date;
}

/**
 * Valid transitions (anything else throws InvalidTransactionStateError):
 *   PENDING           → PROCESSED | PENDING_REFERENCE | REJECTED | FAILED
 *   PENDING_REFERENCE → PROCESSED | PENDING_REFERENCE (next retry) | REJECTED | FAILED
 *   PROCESSED, REJECTED, FAILED are terminal.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Starts in PENDING. Validates kind, amount and the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new InvalidWagerTransactionError(`kind "${props.kind}" cannot be submitted`);
    }
    for (const field of ['id', 'providerId', 'externalTransactionId', 'idempotencyKey', 'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      if (props[field].trim() === '') {
        throw new InvalidWagerTransactionError(`${field} must not be empty`);
      }
    }
    if (props.money.isNegative()) {
      throw new InvalidWagerTransactionError('amount must not be negative');
    }
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${props.kind} amount must be greater than zero`);
    }
    const ref = props.referenceExternalTransactionId;
    if (ref !== undefined && ref.trim() === '') {
      throw new InvalidWagerTransactionError('referenceExternalTransactionId must not be empty');
    }
    if (requiresReference(props.kind) && ref === undefined) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (props.kind === WagerTransactionKind.Bet && ref !== undefined) {
      throw new InvalidWagerTransactionError('BET does not take a reference');
    }
    if (ref === props.externalTransactionId) {
      throw new InvalidWagerTransactionError('a transaction cannot reference itself');
    }
    return WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
      updatedAt: props.createdAt,
    });
  }

  /** Internal OPENING credit, born PROCESSED in the same SQL transaction as the wallet. */
  static createOpening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const fields = {
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: 'opening',
      gameId: 'internal',
      kind: WagerTransactionKind.Opening,
      money: props.money.toJSON(),
    };
    return WagerTransaction.rehydrate({
      ...fields,
      id: props.id,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: computePayloadHash(fields),
      money: props.money,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      processedAt: props.at,
      resultBalance: props.money,
      referenceAttempts: 0,
      updatedAt: props.at,
    });
  }

  /** Rebuilds persisted state as-is; does not re-validate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
      state.updatedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, resultBalance: Money, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  /** Counts one reference lookup attempt and schedules the next with exponential backoff. */
  markPendingReference(at: Date, policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY): void {
    this.assertNotTerminal('markPendingReference');
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(`transaction ${this.id} has no reference to wait for`);
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    const delayMs = policy.baseDelayMs * 2 ** (this._referenceAttempts - 1);
    this._nextReferenceAttemptAt = new Date(at.getTime() + delayMs);
    this._updatedAt = at;
  }

  reject(code: FailureCode, observedBalance: Money | undefined, at: Date): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false for LOSS: it records the round result without moving money. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return requiresReference(this.kind);
  }

  isReversal(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** True while the lookup happening now is not yet the last one allowed by the policy. */
  canWaitForReference(policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY): boolean {
    return this._referenceAttempts + 1 < policy.maxAttempts;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverts the reference's own direction; the other kinds have a fixed direction. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new InvalidTransactionStateError(`ROLLBACK ${this.id} needs its reference to know the direction`);
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS has no ledger direction');
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`cannot ${transition}: transaction ${this.id} is already ${this._status}`);
    }
  }
}

function requiresReference(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}
