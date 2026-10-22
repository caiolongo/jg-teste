import type { IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { FailureCode } from '../../domain/wager/failure-code';
import { computePayloadHash } from '../../domain/wager/payload-hash';
import { type SettlementOutcome, settleWagerTransaction } from '../../domain/wager/wager-settlement';
import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  type PendingReferencePolicy,
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import { IdempotencyConflictError, TransientInfrastructureError, WalletNotFoundError } from '../errors';
import type { TransactionalRepositories, UnitOfWork } from '../ports/repositories';
import type { AppLogger, Clock, IdGenerator, Metrics } from '../ports/system';

export interface ProcessWagerCommand {
  /** Source of truth for idempotency (HTTP header or message field). */
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
  correlationId: string;
  /** What caused this processing (e.g. the SQS messageId); copied to the events. */
  causationId?: string | undefined;
  /** Present only for queue input: the inbox record is written in the same SQL transaction. */
  inbox?: { consumerName: string; messageId: string } | undefined;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Balance observed when the transaction was resolved; absent while it is still pending. */
  balance: MoneyProps | undefined;
  failureCode: FailureCode | undefined;
  idempotentReplay: boolean;
}

export type ProcessWagerOutcome = { type: 'result'; result: WagerResult } | { type: 'duplicate-message' };

export function toWagerResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  return {
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultBalance?.toJSON(),
    failureCode: tx.failureCode,
    idempotentReplay,
  };
}

/**
 * The single write path for provider transactions, shared by HTTP and SQS.
 *
 * One SQL transaction: [inbox] → idempotency check → lock wallet (FOR UPDATE) → insert PENDING →
 * resolve reference → domain settlement → transaction + wallet + ledger + outbox → commit.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly pendingReferencePolicy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerOutcome> {
    const startedAt = performance.now();
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash({ ...command, money: money.toJSON() });
    const now = this.clock.now();
    // Validates kind (OPENING is refused), amount and reference requirement before touching the database.
    const candidate = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });
    const log = {
      correlationId: command.correlationId,
      messageId: command.inbox?.messageId,
      providerId: command.providerId,
      walletId: command.walletId,
    };

    const outcome = await this.uow.run(async (repos): Promise<ProcessWagerOutcome> => {
      let inbox: InboxMessage | undefined;
      if (command.inbox) {
        inbox = InboxMessage.receive({ ...command.inbox, payloadHash, receivedAt: now });
        if (!(await repos.inbox.tryReceive(inbox))) {
          return { type: 'duplicate-message' };
        }
      }
      const markInbox = async () => {
        if (inbox) {
          inbox.markProcessed(this.clock.now());
          await repos.inbox.markProcessed(inbox);
        }
      };

      // Fast path for replays: no wallet lock needed.
      const existing = await this.findExisting(repos, candidate);
      if (existing) {
        await markInbox();
        return { type: 'result', result: this.replay(existing, candidate) };
      }

      const wallet = await repos.wallets.findByIdForUpdate(candidate.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(`wallet ${candidate.walletId} not found`);
      }

      // A concurrent duplicate may have committed while we waited for the lock: ON CONFLICT tells us.
      if (!(await repos.transactions.insertIfAbsent(candidate))) {
        const winner = await this.findExisting(repos, candidate);
        if (!winner) throw new Error(`insert of ${candidate.idempotencyKey} conflicted but no row is visible`);
        await markInbox();
        return { type: 'result', result: this.replay(winner, candidate) };
      }

      await this.settleAndPersist(repos, candidate, wallet, {
        correlationId: command.correlationId,
        causationId: command.causationId,
      });
      await markInbox();
      return { type: 'result', result: toWagerResult(candidate, false) };
    });

    if (outcome.type === 'duplicate-message') {
      this.metrics.duplicateDetected('inbox');
      this.logger.info('duplicate message ignored', log);
    } else if (outcome.result.idempotentReplay) {
      this.metrics.duplicateDetected('idempotency_replay');
      this.logger.info('idempotent replay', { ...log, transactionId: outcome.result.transactionId });
    } else {
      const { result } = outcome;
      this.metrics.transactionResolved(result.status, candidate.kind);
      this.logger.info('wager transaction resolved', {
        ...log,
        transactionId: result.transactionId,
        kind: candidate.kind,
        status: result.status,
        failureCode: result.failureCode,
      });
    }
    this.metrics.processingDuration((performance.now() - startedAt) / 1_000, outcome.type === 'result' ? outcome.result.status : 'DUPLICATE');
    return outcome;
  }

  /**
   * Retries one due PENDING_REFERENCE transaction (claimed with SKIP LOCKED). Returns undefined when none is due.
   * Each call is its own SQL transaction, so a failure affects only that transaction.
   *
   * A transient failure (database down, lock timeout) leaves it pending for the next round. Any other failure is
   * permanent — retrying would fail forever — so the transaction is marked FAILED (PROCESSING_FAILED), terminal
   * and auditable, with a WagerTransactionFailed event, in a separate SQL transaction.
   */
  async retryNextPendingReference(): Promise<WagerResult | undefined> {
    let claimedId: string | undefined;
    let result: WagerResult | undefined;
    try {
      result = await this.uow.run(async (repos) => {
        const [tx] = await repos.transactions.claimDuePendingReferences(this.clock.now(), 1);
        if (!tx) return undefined;
        claimedId = tx.id;
        const wallet = await repos.wallets.findByIdForUpdate(tx.walletId);
        if (!wallet) throw new WalletNotFoundError(`wallet ${tx.walletId} not found`);
        // The original request's correlation id is not stored; the transaction id ties the events together.
        await this.settleAndPersist(repos, tx, wallet, { correlationId: tx.id, causationId: undefined });
        return toWagerResult(tx, false);
      });
    } catch (error) {
      if (claimedId === undefined || error instanceof TransientInfrastructureError) throw error;
      result = await this.markFailed(claimedId, error);
      if (!result) return undefined;
    }
    if (result) {
      if (result.status !== WagerTransactionStatus.PendingReference) {
        this.metrics.transactionResolved(result.status, 'PENDING_REFERENCE_RETRY');
      }
      this.logger.info('pending reference retried', {
        transactionId: result.transactionId,
        status: result.status,
        failureCode: result.failureCode,
      });
    }
    return result;
  }

  private async markFailed(transactionId: string, cause: unknown): Promise<WagerResult | undefined> {
    const result = await this.uow.run(async (repos) => {
      // Locked so a concurrent worker cannot settle or fail it at the same time.
      const tx = await repos.transactions.findByIdForUpdate(transactionId);
      if (!tx || tx.isTerminal()) return undefined;
      const at = this.clock.now();
      tx.fail(FailureCode.ProcessingFailed, at);
      await repos.transactions.update(tx);
      const event = WagerTransactionFailed.from(tx, { eventId: this.ids.next(), correlationId: tx.id, occurredAt: at });
      await repos.outbox.addAll([OutboxMessage.enqueue(event)]);
      return toWagerResult(tx, false);
    });
    if (result) {
      this.logger.error('pending transaction failed permanently', {
        transactionId,
        failureCode: FailureCode.ProcessingFailed,
        error: cause instanceof Error ? cause.message : 'unknown',
      });
    }
    return result;
  }

  private async settleAndPersist(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    wallet: Wallet,
    trace: { correlationId: string; causationId: string | undefined },
  ): Promise<SettlementOutcome> {
    const reference =
      tx.referenceExternalTransactionId === undefined
        ? undefined
        : await repos.transactions.findByProviderAndExternalId(tx.providerId, tx.referenceExternalTransactionId);
    // Race-free: every reversal of this reference targets the same wallet, whose row we hold locked.
    const referenceAlreadyReversed = reference !== undefined && tx.isReversal() ? await repos.transactions.hasProcessedReversal(reference.id) : false;
    const at = this.clock.now();

    const outcome = settleWagerTransaction({
      transaction: tx,
      wallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at,
      policy: this.pendingReferencePolicy,
    });

    await repos.transactions.update(tx);
    const ctx = () => ({ eventId: this.ids.next(), correlationId: trace.correlationId, causationId: trace.causationId, occurredAt: at });
    const events: IntegrationEvent<unknown>[] = [];
    switch (outcome.status) {
      case WagerTransactionStatus.Processed:
        if (outcome.ledgerEntry) {
          await repos.wallets.update(wallet);
          await repos.ledger.append(outcome.ledgerEntry);
          events.push(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx()));
        }
        events.push(WagerTransactionProcessed.from(tx, ctx()));
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(tx, ctx()));
        break;
      case WagerTransactionStatus.PendingReference:
        events.push(WagerTransactionPendingReference.from(tx, ctx()));
        break;
    }
    await repos.outbox.addAll(events.map((event) => OutboxMessage.enqueue(event)));
    if (outcome.status === WagerTransactionStatus.Processed) {
      // A transaction others may be waiting for now exists: let the worker retry them right away.
      await repos.transactions.expediteWaitingFor(tx.providerId, tx.externalTransactionId, at);
    }
    return outcome;
  }

  /** Same key or same (provider, external id): replay when the payload matches, conflict otherwise. */
  private async findExisting(repos: TransactionalRepositories, candidate: WagerTransaction): Promise<WagerTransaction | undefined> {
    return (
      (await repos.transactions.findByIdempotencyKey(candidate.idempotencyKey)) ??
      (await repos.transactions.findByProviderAndExternalId(candidate.providerId, candidate.externalTransactionId))
    );
  }

  private replay(existing: WagerTransaction, candidate: WagerTransaction): WagerResult {
    const sameOperation =
      existing.idempotencyKey === candidate.idempotencyKey && existing.matchesPayload(candidate.payloadHash);
    if (!sameOperation) {
      this.metrics.idempotencyConflict();
      throw new IdempotencyConflictError(
        `idempotency key ${candidate.idempotencyKey} / external id ${candidate.externalTransactionId} already used with a different payload`,
        existing.id,
      );
    }
    return toWagerResult(existing, true);
  }
}
