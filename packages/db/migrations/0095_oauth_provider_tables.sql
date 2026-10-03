-- 0095_oauth_provider_tables.sql
-- OAuth 2.1 authorization-server tables for the MCP control plane.
--
-- Transcribed from Better Auth 1.7.4's own schema generator for the plugin set
-- jwt() + mcp() + cimd() on provider "pg" — column names, nullability, array and
-- jsonb choices, and index names all come from the generator rather than from
-- hand-reading the plugin source. The drizzle mirror in
-- packages/db/src/schema/better-auth-oauth.ts is the same generator output, so the
-- adapter's own runtime schema check has nothing to disagree with.
--
-- Timestamps are timestamptz to match the four Better Auth tables already in this
-- database (0007, 0087). The generator emits a naive `timestamp`; storing an
-- instant without its offset in a deployment whose other auth rows carry one is a
-- worse inconsistency than diverging from the generator on this one point.
--
-- Domain code never reads or writes these tables. Better Auth owns every row.

create table if not exists "jwks" (
  id           text primary key,
  "publicKey"  text not null,
  "privateKey" text not null,
  "createdAt"  timestamptz not null,
  "expiresAt"  timestamptz,
  alg          text,
  crv          text
);

create table if not exists "oauthClient" (
  id                                 text primary key,
  "clientId"                         text not null unique,
  "clientSecret"                     text,
  "clientDiscoveryId"                text,
  disabled                           boolean default false,
  "skipConsent"                      boolean,
  "enableEndSession"                 boolean,
  "subjectType"                      text,
  scopes                             text[],
  "clientCredentialsScopes"          text[] default '{}',
  "userId"                           text references "user"(id) on delete cascade,
  "createdAt"                        timestamptz,
  "updatedAt"                        timestamptz,
  name                               text,
  uri                                text,
  icon                               text,
  contacts                           text[],
  tos                                text,
  policy                             text,
  "softwareId"                       text,
  "softwareVersion"                  text,
  "softwareStatement"                text,
  "redirectUris"                     text[] not null,
  "postLogoutRedirectUris"           text[],
  "backchannelLogoutUri"             text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod"          text,
  "applicationType"                  text,
  jwks                               text,
  "jwksUri"                          text,
  "grantTypes"                       text[],
  "responseTypes"                    text[],
  "requirePKCE"                      boolean,
  "dpopBoundAccessTokens"            boolean default false,
  "referenceId"                      text,
  metadata                           jsonb
);

create index if not exists "oauthClient_userId_idx" on "oauthClient"("userId");

create table if not exists "oauthResource" (
  id                              text primary key,
  identifier                      text not null unique,
  name                            text not null,
  "accessTokenTtl"                integer,
  "refreshTokenTtl"               integer,
  "signingAlgorithm"              text,
  "signingKeyId"                  text,
  "allowedScopes"                 text[],
  "customClaims"                  jsonb,
  "dpopBoundAccessTokensRequired" boolean default false,
  disabled                        boolean default false,
  "createdAt"                     timestamptz,
  "updatedAt"                     timestamptz,
  "policyVersion"                 integer default 1,
  metadata                        jsonb
);

create table if not exists "oauthClientResource" (
  id           text primary key,
  "clientId"   text not null references "oauthClient"("clientId") on delete cascade,
  "resourceId" text not null references "oauthResource"(identifier) on delete cascade,
  metadata     jsonb,
  "createdAt"  timestamptz
);

create unique index if not exists "oauthClientResource_clientId_resourceId_uidx"
  on "oauthClientResource"("clientId", "resourceId");
create index if not exists "oauthClientResource_clientId_idx" on "oauthClientResource"("clientId");
create index if not exists "oauthClientResource_resourceId_idx" on "oauthClientResource"("resourceId");

create table if not exists "oauthRefreshToken" (
  id                        text primary key,
  token                     text not null unique,
  "clientId"                text not null references "oauthClient"("clientId") on delete cascade,
  "sessionId"               text references "session"(id) on delete set null,
  "userId"                  text not null references "user"(id) on delete cascade,
  "referenceId"             text,
  "authorizationCodeId"     text,
  resources                 text[],
  "requestedUserInfoClaims" text[],
  "expiresAt"               timestamptz,
  "createdAt"               timestamptz,
  revoked                   timestamptz,
  "rotatedAt"               timestamptz,
  "rotationReplayResponse"  text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime"                timestamptz,
  confirmation              jsonb,
  scopes                    text[] not null
);

create index if not exists "oauthRefreshToken_clientId_idx" on "oauthRefreshToken"("clientId");
create index if not exists "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken"("sessionId");
create index if not exists "oauthRefreshToken_userId_idx" on "oauthRefreshToken"("userId");
create index if not exists "oauthRefreshToken_authorizationCodeId_idx"
  on "oauthRefreshToken"("authorizationCodeId");

create table if not exists "oauthAccessToken" (
  id                        text primary key,
  token                     text unique,
  "clientId"                text not null references "oauthClient"("clientId") on delete cascade,
  "sessionId"               text references "session"(id) on delete set null,
  "userId"                  text references "user"(id) on delete cascade,
  "referenceId"             text,
  "authorizationCodeId"     text,
  resources                 text[],
  "requestedUserInfoClaims" text[],
  "refreshId"               text references "oauthRefreshToken"(id) on delete cascade,
  "expiresAt"               timestamptz,
  "createdAt"               timestamptz,
  revoked                   timestamptz,
  confirmation              jsonb,
  scopes                    text[] not null
);

create index if not exists "oauthAccessToken_clientId_idx" on "oauthAccessToken"("clientId");
create index if not exists "oauthAccessToken_sessionId_idx" on "oauthAccessToken"("sessionId");
create index if not exists "oauthAccessToken_userId_idx" on "oauthAccessToken"("userId");
create index if not exists "oauthAccessToken_authorizationCodeId_idx"
  on "oauthAccessToken"("authorizationCodeId");
create index if not exists "oauthAccessToken_refreshId_idx" on "oauthAccessToken"("refreshId");

create table if not exists "oauthConsent" (
  id                        text primary key,
  "clientId"                text not null references "oauthClient"("clientId") on delete cascade,
  "userId"                  text references "user"(id) on delete cascade,
  "referenceId"             text,
  resources                 text[],
  "requestedUserInfoClaims" text[],
  scopes                    text[] not null,
  "createdAt"               timestamptz,
  "updatedAt"               timestamptz
);

create index if not exists "oauthConsent_clientId_idx" on "oauthConsent"("clientId");
create index if not exists "oauthConsent_userId_idx" on "oauthConsent"("userId");

-- Replay ledger for private_key_jwt client assertions: the row id IS the assertion
-- jti, so a second presentation collides on the primary key. There is nothing else
-- to store, which is why this table has only an expiry.
create table if not exists "oauthClientAssertion" (
  id          text primary key,
  "expiresAt" timestamptz not null
);
