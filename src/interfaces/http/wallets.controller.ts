import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { LedgerEntryView } from '../../application/queries';
import { WageringQueries } from '../../application/queries';
import { CreateWallet, type WalletView } from '../../application/wallets/create-wallet';
import { type ReconciliationReport, ReconcileWallet } from '../../application/wallets/reconcile-wallet';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor';
import { CreateWalletBody, LedgerQuery, parse, UuidParam } from './validation';

type CorrelatedRequest = Request & { correlationId: string };

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly queries: WageringQueries,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() raw: unknown, @Req() request: CorrelatedRequest): Promise<WalletView> {
    const body = parse(CreateWalletBody, raw);
    return this.createWallet.execute({ ...body, correlationId: request.correlationId });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(parse(UuidParam, walletId, 'INVALID_WALLET_ID'));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') rawWalletId: string,
    @Query() rawQuery: unknown,
  ): Promise<{ entries: LedgerEntryView[]; nextCursor: string | null }> {
    const walletId = parse(UuidParam, rawWalletId, 'INVALID_WALLET_ID');
    const query = parse(LedgerQuery, rawQuery, 'INVALID_QUERY');
    const afterVersion = query.cursor === undefined ? undefined : decodeLedgerCursor(walletId, query.cursor);
    const page = await this.queries.getLedger(walletId, { afterVersion, limit: query.limit });
    return {
      entries: page.entries,
      nextCursor: page.nextAfterVersion === undefined ? null : encodeLedgerCursor(walletId, page.nextAfterVersion),
    };
  }

  /** POST: it runs a check and records its outcome (log + metric), it is not a plain read. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string, @Req() request: CorrelatedRequest): Promise<ReconciliationReport> {
    return this.reconcileWallet.execute(parse(UuidParam, walletId, 'INVALID_WALLET_ID'), request.correlationId);
  }
}
