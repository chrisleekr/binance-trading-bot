-- Durable outcome record for override actions.
--
-- A dust-transfer is a money-path action, so its result (assets actually
-- converted, BNB received, Binance service charge) must survive as history the
-- operator can review, not just as a transient log line. The dust-snapshot
-- executor writes Binance's convertDust response here on finalisation; the
-- dust-history API reads it. Nullable: pending/failed actions and every
-- non-dust action leave it null. jsonb mirrors the opaque `payload` column.
alter table override_actions
  add column if not exists result jsonb;
