-- Operator can hide an unrecoverable coin from the "no recoverable history"
-- note and show it again later. `dismissed_at` is null while the coin is
-- visible in the note; a timestamp once hidden. Per (profile, symbol), so the
-- hidden state persists across devices.
alter table backfill_attempts add column if not exists dismissed_at timestamptz;
