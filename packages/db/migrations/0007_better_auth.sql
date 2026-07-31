-- 0007_better_auth.sql
-- Better Auth schema. We accept the upstream column names (camelCase, text id)
-- verbatim so the drizzle adapter does not need a per-column override map; the
-- domain `users` table (0003_identity.sql) is kept distinct and references this
-- table only via the post-onboarding hook in #27. Domain code never touches the
-- Better Auth tables directly — repo helpers go through the auth API.
--
-- Schema source: Better Auth v1.3 default tables. The columns mirror what
-- `bunx @better-auth/cli generate` would emit for the email+password adapter
-- with no plugins enabled.

create table if not exists "user" (
  id              text primary key,
  email           text unique not null,
  "emailVerified" boolean not null default false,
  name            text,
  image           text,
  "createdAt"     timestamptz not null default now(),
  "updatedAt"     timestamptz not null default now()
);

create table if not exists "session" (
  id          text primary key,
  "userId"    text not null references "user"(id) on delete cascade,
  token       text unique not null,
  "expiresAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists session_user_id_idx on "session"("userId");
create index if not exists session_expires_at_idx on "session"("expiresAt");

create table if not exists "account" (
  id                       text primary key,
  "userId"                 text not null references "user"(id) on delete cascade,
  "providerId"             text not null,
  "accountId"              text not null,
  password                 text,
  "accessToken"            text,
  "refreshToken"           text,
  "idToken"                text,
  "accessTokenExpiresAt"   timestamptz,
  "refreshTokenExpiresAt"  timestamptz,
  scope                    text,
  "createdAt"              timestamptz not null default now(),
  "updatedAt"              timestamptz not null default now()
);

create unique index if not exists account_provider_uniq on "account"("providerId", "accountId");
create index if not exists account_user_id_idx on "account"("userId");

create table if not exists "verification" (
  id           text primary key,
  identifier   text not null,
  value        text not null,
  "expiresAt"  timestamptz not null,
  "createdAt"  timestamptz default now(),
  "updatedAt"  timestamptz default now()
);

create index if not exists verification_identifier_idx on "verification"(identifier);
