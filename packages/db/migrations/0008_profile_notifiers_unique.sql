-- 0008_profile_notifiers_unique.sql
-- Lock the (profile_id, provider) pair so the writable notifier-config endpoint
-- can use `INSERT ... ON CONFLICT DO UPDATE` and not race two concurrent
-- saves into duplicate rows. The repo's `upsertByProvider` depends on this
-- index existing.

create unique index if not exists profile_notifiers_profile_provider_uq
  on profile_notifiers (profile_id, provider);
