-- Remove the automatic dust-to-BNB conversion feature.
--
-- The bot no longer moves funds automatically: automatic dust conversion could
-- sweep an operator's quote/funding asset (e.g. USDT) because the safety filter
-- only excluded base assets (symbol prefixes), never quote assets (suffixes).
-- Dust conversion is now operator-initiated only, via the manual dust-transfer
-- screen. This drops the auto-convert config singleton and the partial unique
-- index that made the (now removed) system-triggered enqueue atomic.
--
-- Idempotent: safe to re-run. Greenfield/not-deployed, so no data migration.
drop index if exists override_actions_pending_auto_dust_uniq;

drop table if exists dust_auto_convert_config;
