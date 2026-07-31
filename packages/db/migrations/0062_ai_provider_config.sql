-- Global singleton holding the operator's AI-assist provider settings (advisor +
-- optimizer). System-wide, not per-user / per-profile, so exactly one row exists;
-- the `id = 1` CHECK plus a default of 1 make a second row impossible.
--
-- Secrets are stored plaintext, consistent with `api_keys` and
-- `profile_notifiers.secrets` (the single allowed path per the auth threat model:
-- single-tenant, operator-controlled). One row is seeded so every read finds it.
create table if not exists ai_provider_config (
  id                    integer primary key default 1 check (id = 1),
  provider              text not null default 'anthropic'
                          check (provider in ('anthropic', 'openai-compatible')),
  anthropic_api_key     text not null default '',
  anthropic_oauth_token text not null default '',
  anthropic_model       text not null default 'claude-sonnet-5',
  openai_base_url       text not null default 'http://host.docker.internal:11434/v1',
  openai_api_key        text not null default '',
  openai_model          text not null default '',
  updated_at            timestamptz not null default now()
);

insert into ai_provider_config (id) values (1) on conflict do nothing;
