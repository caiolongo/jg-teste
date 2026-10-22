import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { type TransactionView, WageringQueries } from '../../application/queries';
import { ProcessWagerTransaction, type WagerResult } from '../../application/wagering/process-wager-transaction';
import { FAILURE_CODE_ACTIONS, type ProviderAction } from '../../domain/wager/failure-code';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction';
import { IdempotencyKeyHeader, parse, UuidParam, WagerTransactionBody } from './validation';

type CorrelatedRequest = Request & { correlationId: string };

/** Status by outcome; a replay returns the same status as the original response. */
const STATUS_BY_RESULT: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

export interface WagerResponse extends WagerResult {
  providerAction: ProviderAction | undefined;
}

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() raw: unknown,
    @Req() request: CorrelatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerResponse> {
    const idempotencyKey = parse(IdempotencyKeyHeader, rawKey, 'MISSING_IDEMPOTENCY_KEY');
    const body = parse(WagerTransactionBody, raw);
    const outcome = await this.processWager.execute({ ...body, idempotencyKey, correlationId: request.correlationId });
    if (outcome.type !== 'result') {
      throw new Error('HTTP input never carries inbox data');
    }
    const { result } = outcome;
    response.status(STATUS_BY_RESULT[result.status]);
    return { ...result, providerAction: result.failureCode ? FAILURE_CODE_ACTIONS[result.failureCode] : undefined };
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    return this.queries.getTransaction(parse(UuidParam, transactionId, 'INVALID_TRANSACTION_ID'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
