-- 0098_auth_security_hardening.sql
-- Storage for the hardened sign-in system. Every change here is additive with a default, so a pod still running the previous release keeps working against the migrated schema during the rollout.

-- Operator-tunable sign-in protection (rate limits, lockout, session lifetimes, security event retention) plus the security epoch. The settings document is validated by the application against hard ranges on every read and write, so an out-of-range value stored by hand is replaced by the strict defaults rather than obeyed. Singleton: the check pins the only row to id 1.
create table if not exists auth_security_settings (
  id              smallint primary key default 1 check (id = 1),
  settings        jsonb not null default '{}'::jsonb,
  -- Incremented by "sign out everywhere", a password reset, a password change and a restore. Every session and known-device cookie carries the epoch it was issued under; one lower than this is refused. One integer revokes everything at once, across every api replica, without enumerating sessions.
  security_epoch  integer not null default 0,
  -- AI agent access tokens are signed JWTs checked by signature and expiry alone, so deleting their grant rows cannot end one already issued. Every revocation stamps this, and the agent endpoint refuses a token issued before it.
  agent_access_not_before timestamptz,
  updated_at      timestamptz not null default now()
);
insert into auth_security_settings (id) values (1) on conflict (id) do nothing;

-- Columns Better Auth writes through `session.additionalFields`.
-- securityEpoch: the epoch the session was issued under (see above).
-- signInMethod: how the session was created, so a re-authentication check can tell a single sign-on session from a password one.
-- interactiveAuthenticatedAt: when the person last actually proved who they are. For single sign-on this is the identity provider's `auth_time`, which stays old when the provider silently reused its own session; that is what lets "sign in again" mean something.
alter table "session" add column if not exists "securityEpoch" integer not null default 0;
alter table "session" add column if not exists "signInMethod" text;
alter table "session" add column if not exists "interactiveAuthenticatedAt" timestamptz;

-- Separates security events from ordinary audit rows. They have their own, longer retention (so lowering general audit retention cannot erase evidence of a compromise) and their own reader on the Security page.
alter table audit_logs add column if not exists category text not null default 'general';
alter table audit_logs drop constraint if exists audit_logs_category_check;
alter table audit_logs add constraint audit_logs_category_check check (category in ('general', 'security'));
create index if not exists audit_logs_security_recent
  on audit_logs (operator_id, created_at desc)
  where category = 'security';
