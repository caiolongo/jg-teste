import { Migration } from '@mikro-orm/migrations';

/**
 * Integrity rules that a CHECK cannot express, enforced by triggers so they hold for any writer:
 *  - the ledger is append-only and forms a gap-free chain per wallet;
 *  - wallet balance and ledger are a bijection: every balance change has its entry and vice versa;
 *  - wallets are never deleted and version moves only with the balance;
 *  - wager transactions are never deleted, their business fields never change,
 *    and terminal statuses (PROCESSED, REJECTED, FAILED) are final.
 */
export class Migration20261021000003CreateIntegrityTriggers extends Migration {
  override name = 'Migration20261021000003CreateIntegrityTriggers';

  override up(): void {
    // ---- ledger: append-only
    this.addSql(`
      create function ledger_reject_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op
          using errcode = 'integrity_constraint_violation';
      end $$`);
    this.addSql(`
      create trigger ledger_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function ledger_reject_mutation()`);
    this.addSql(`
      create trigger ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function ledger_reject_mutation()`);

    // ---- ledger: each entry continues the wallet's chain
    this.addSql(`
      create function ledger_check_chain() returns trigger language plpgsql as $$
      declare
        prev record;
      begin
        select balance_after, wallet_version into prev
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by wallet_version desc
         limit 1;
        if not found then
          if new.balance_before <> 0 then
            raise exception 'first ledger entry of wallet % must start from 0, got %', new.wallet_id, new.balance_before
              using errcode = 'integrity_constraint_violation';
          end if;
        elsif new.wallet_version <= prev.wallet_version then
          raise exception 'ledger entry version % does not follow % for wallet %', new.wallet_version, prev.wallet_version, new.wallet_id
            using errcode = 'integrity_constraint_violation';
        elsif new.balance_before <> prev.balance_after then
          raise exception 'ledger chain broken for wallet %: balance_before % <> previous balance_after %',
            new.wallet_id, new.balance_before, prev.balance_after
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`
      create trigger ledger_chain
        before insert on wallet_ledger_entries
        for each row execute function ledger_check_chain()`);

    // ---- ledger → wallet (checked at commit): an entry must be reflected in the wallet
    this.addSql(`
      create function ledger_check_reflected() returns trigger language plpgsql as $$
      declare
        w record;
      begin
        select balance, version into w from wallets where id = new.wallet_id;
        if w.version < new.wallet_version
           or (w.version = new.wallet_version and w.balance <> new.balance_after) then
          raise exception 'ledger entry % (version %) is not reflected in wallet % (version %, balance %)',
            new.id, new.wallet_version, new.wallet_id, w.version, w.balance
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end $$`);
    this.addSql(`
      create constraint trigger ledger_reflected_in_wallet
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function ledger_check_reflected()`);

    // ---- wallets: identity is fixed, version moves exactly with the balance, never deleted
    this.addSql(`
      create function wallet_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wallets cannot be deleted' using errcode = 'integrity_constraint_violation';
        end if;
        if tg_op = 'INSERT' then
          if new.version <> 1 then
            raise exception 'a new wallet starts at version 1, got %', new.version
              using errcode = 'integrity_constraint_violation';
          end if;
          return new;
        end if;
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.created_at <> old.created_at then
          raise exception 'wallet % identity columns are immutable', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet % balance changed without incrementing version by 1 (% -> %)', old.id, old.version, new.version
            using errcode = 'integrity_constraint_violation';
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet % version changed without a balance change', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`
      create trigger wallet_guard
        before insert or update or delete on wallets
        for each row execute function wallet_guard()`);

    // ---- wallet → ledger (checked at commit): every balance change has its entry
    this.addSql(`
      create function wallet_check_ledger() returns trigger language plpgsql as $$
      begin
        if (tg_op = 'INSERT' and new.balance = 0)
           or (tg_op = 'UPDATE' and new.balance = old.balance) then
          return null;
        end if;
        if not exists (
          select 1 from wallet_ledger_entries
           where wallet_id = new.id and wallet_version = new.version and balance_after = new.balance
        ) then
          raise exception 'wallet % balance % (version %) has no matching ledger entry', new.id, new.balance, new.version
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end $$`);
    this.addSql(`
      create constraint trigger wallet_balance_has_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallet_check_ledger()`);

    // ---- wager transactions: never deleted, business fields fixed, terminal statuses final
    this.addSql(`
      create function wager_tx_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager transactions cannot be deleted' using errcode = 'integrity_constraint_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'wager transaction % is % (terminal) and cannot change', old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if old.status = 'PENDING_REFERENCE' and new.status = 'PENDING' then
          raise exception 'wager transaction % cannot go back to PENDING', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'wager transaction % business fields are immutable', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end $$`);
    this.addSql(`
      create trigger wager_tx_guard
        before update or delete on wager_transactions
        for each row execute function wager_tx_guard()`);
  }

  override down(): void {
    this.addSql('drop trigger if exists wager_tx_guard on wager_transactions');
    this.addSql('drop function if exists wager_tx_guard()');
    this.addSql('drop trigger if exists wallet_balance_has_ledger on wallets');
    this.addSql('drop function if exists wallet_check_ledger()');
    this.addSql('drop trigger if exists wallet_guard on wallets');
    this.addSql('drop function if exists wallet_guard()');
    this.addSql('drop trigger if exists ledger_reflected_in_wallet on wallet_ledger_entries');
    this.addSql('drop function if exists ledger_check_reflected()');
    this.addSql('drop trigger if exists ledger_chain on wallet_ledger_entries');
    this.addSql('drop function if exists ledger_check_chain()');
    this.addSql('drop trigger if exists ledger_no_truncate on wallet_ledger_entries');
    this.addSql('drop trigger if exists ledger_no_update_delete on wallet_ledger_entries');
    this.addSql('drop function if exists ledger_reject_mutation()');
  }
}
