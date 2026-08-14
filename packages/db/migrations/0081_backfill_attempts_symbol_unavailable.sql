-- Mark a backfill attempt that stopped because the symbol is no longer listed.
--
-- The archive-recovery sweep re-enqueues a backfill for every recoverable
-- symbol every 15 minutes. A symbol that discovery evicted and that Binance no
-- longer lists has no symbol-info row to read, and the handler threw on it: the
-- job retried, dead-lettered, and fired an operator notification, forever.
--
-- Giving up needs its own marker rather than reusing the zero/zero attempt,
-- which the API already reads as "open or pre-history position". Labelling a
-- delisted coin that way would be a plainly wrong explanation for why its
-- history is missing.

alter table backfill_attempts
  add column if not exists symbol_unavailable boolean not null default false;
