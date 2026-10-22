import { Migration } from '@mikro-orm/migrations';

/**
 * Wallets, wager transactions and the ledger, with uniqueness and non-negativity enforced by the schema.
 * Amounts are NUMERIC(20,2): exact decimal, 2 places, matching the domain's integer cents.
 */
export class Migration20261021000001CreateFinancialTables extends Migration {
  override name = 'Migration20261021000001CreateFinancialTables';

  override up(): void {
    this.addSql(`
      create table wallets (
        id          uuid           primary key,
        player_id   uuid           not null,
        currency    char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) not null check (balance >= 0),
        version     integer        not null check (version >= 1),
        created_at  timestamptz    not null,
        updated_at  timestamptz    not null,
        constraint wallets_player_currency_uq unique (player_id, currency),
        -- target for the ledger's composite FK: an entry's currency must be its wallet's currency
        constraint wallets_id_currency_uq unique (id, currency)
      )`);

    this.addSql(`
      create table wager_transactions (
        id                                 uuid           primary key,
        provider_id                        text           not null check (provider_id <> ''),
        external_transaction_id            text           not null check (external_transaction_id <> ''),
        idempotency_key                    text           not null check (idempotency_key <> ''),
        payload_hash                       char(64)       not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                          uuid           not null references wallets (id),
        player_id                          uuid           not null,
        round_id                           text           not null check (round_id <> ''),
        game_id                            text           not null check (game_id <> ''),
        kind                               text           not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                             numeric(20, 2) not null check (amount >= 0),
        currency                           char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id  text,
        reference_transaction_id           uuid           references wager_transactions (id),
        status                             text           not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                       text,
        -- balance observed when resolved (returned on replays); its own currency, since a
        -- CURRENCY_MISMATCH rejection observes the wallet balance in the wallet currency
        result_balance                     numeric(20, 2) check (result_balance >= 0),
        result_currency                    char(3)        check (result_currency ~ '^[A-Z]{3}$'),
        reference_attempts                 integer        not null default 0 check (reference_attempts >= 0),
        next_reference_attempt_at          timestamptz,
        processed_at                       timestamptz,
        created_at                         timestamptz    not null,
        updated_at                         timestamptz    not null,

        constraint wager_tx_idempotency_key_uq unique (idempotency_key),
        constraint wager_tx_provider_external_uq unique (provider_id, external_transaction_id),
        -- target for the ledger's composite FK: an entry must belong to its transaction's wallet
        constraint wager_tx_id_wallet_uq unique (id, wallet_id),

        constraint wager_tx_amount_positive_ck
          check (kind = 'LOSS' or amount > 0),
        constraint wager_tx_reference_required_ck
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_tx_bet_without_reference_ck
          check (kind <> 'BET' or reference_external_transaction_id is null),
        constraint wager_tx_processed_at_ck
          check ((status = 'PROCESSED') = (processed_at is not null)),
        constraint wager_tx_failure_code_ck
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        constraint wager_tx_pending_reference_ck
          check ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at is not null)),
        constraint wager_tx_result_balance_ck
          check ((result_balance is null) = (result_currency is null)),
        constraint wager_tx_resolved_reference_ck
          check (reference_transaction_id is null or status = 'PROCESSED')
      )`);

    // ARCHITECTURE.md §8, interpretation 1: a transaction is reversed at most once in total, whatever the reversal kind.
    this.addSql(`
      create unique index wager_tx_single_reversal_uq
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'`);

    // Pending-reference worker: only the due rows, nothing else.
    this.addSql(`
      create index wager_tx_pending_reference_due_idx
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'`);

    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at)`);

    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid           primary key,
        wallet_id       uuid           not null,
        transaction_id  uuid           not null,
        direction       text           not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) not null check (amount > 0),
        currency        char(3)        not null,
        balance_before  numeric(20, 2) not null check (balance_before >= 0),
        balance_after   numeric(20, 2) not null check (balance_after >= 0),
        wallet_version  integer        not null check (wallet_version >= 1),
        created_at      timestamptz    not null,

        constraint ledger_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint ledger_transaction_wallet_fk
          foreign key (transaction_id, wallet_id) references wager_transactions (id, wallet_id),
        -- at most one entry per wallet per financial transaction
        constraint ledger_transaction_wallet_uq unique (transaction_id, wallet_id),
        -- one entry per wallet version: also the stable cursor for ledger pagination
        constraint ledger_wallet_version_uq unique (wallet_id, wallet_version),
        constraint ledger_balanced_ck check (
          balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end
        )
      )`);
  }

  override down(): void {
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
  }
}
