-- 0001_extensions.sql
-- Idempotent extension bootstrap. Re-run produces no diff.
-- TimescaleDB must precede any hypertable migrations (see 0006_hypertables.sql).

create extension if not exists "timescaledb";
create extension if not exists "citext";
create extension if not exists "pgcrypto";
create extension if not exists "pg_stat_statements";
