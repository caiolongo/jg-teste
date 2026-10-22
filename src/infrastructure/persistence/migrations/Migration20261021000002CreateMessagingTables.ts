import { Migration } from '@mikro-orm/migrations';

/** Persistent inbox (consumer dedup) and transactional outbox. */
export class Migration20261021000002CreateMessagingTables extends Migration {
  override name = 'Migration20261021000002CreateMessagingTables';

  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name  text        not null check (consumer_name <> ''),
        message_id     text        not null check (message_id <> ''),
        payload_hash   char(64)    not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at    timestamptz not null,
        processed_at   timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id)
      )`);

    this.addSql(`
      create table outbox_messages (
        id               uuid        primary key,
        aggregate_id     text        not null,
        event_type       text        not null check (event_type <> ''),
        payload          jsonb       not null,
        occurred_at      timestamptz not null,
        attempts         integer     not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       text,
        constraint outbox_published_not_scheduled_ck check (published_at is null or next_attempt_at is null)
      )`);

    // Publishers scan only unpublished rows, oldest due first.
    this.addSql(`
      create index outbox_pending_due_idx
        on outbox_messages (next_attempt_at, occurred_at)
        where published_at is null`);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages');
    this.addSql('drop table if exists inbox_messages');
  }
}
