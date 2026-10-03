import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { session, user } from './better-auth.js';

/**
 * OAuth 2.1 authorization-server tables, owned entirely by Better Auth's `jwt()`, `mcp()` and `cimd()` plugins and created by migration 0095.
 *
 * Every column here is transcribed from Better Auth 1.7.4's own drizzle generator for provider `pg`, because the drizzle adapter runs a schema check against this map at boot: a column this file spells differently from the generator is not a cosmetic difference, it is a runtime "model not found" or a silently dropped field. Exported variable names stay singular camelCase for the same reason the four original tables do, since the adapter resolves model names against the exported variable name rather than the SQL identifier.
 *
 * Domain code MUST NOT read or write these tables. They exist to give the adapter a typed schema, and the access tokens they hold are the MCP control plane's credentials.
 */
export const jwks = pgTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('publicKey').notNull(),
  privateKey: text('privateKey').notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }),
  alg: text('alg'),
  crv: text('crv'),
});

export const oauthClient = pgTable(
  'oauthClient',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId').notNull().unique(),
    clientSecret: text('clientSecret'),
    clientDiscoveryId: text('clientDiscoveryId'),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skipConsent'),
    enableEndSession: boolean('enableEndSession'),
    subjectType: text('subjectType'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('clientCredentialsScopes').array().default([]),
    userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('createdAt', { withTimezone: true }),
    updatedAt: timestamp('updatedAt', { withTimezone: true }),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('softwareId'),
    softwareVersion: text('softwareVersion'),
    softwareStatement: text('softwareStatement'),
    redirectUris: text('redirectUris').array().notNull(),
    postLogoutRedirectUris: text('postLogoutRedirectUris').array(),
    backchannelLogoutUri: text('backchannelLogoutUri'),
    backchannelLogoutSessionRequired: boolean('backchannelLogoutSessionRequired'),
    tokenEndpointAuthMethod: text('tokenEndpointAuthMethod'),
    applicationType: text('applicationType'),
    jwks: text('jwks'),
    jwksUri: text('jwksUri'),
    grantTypes: text('grantTypes').array(),
    responseTypes: text('responseTypes').array(),
    requirePKCE: boolean('requirePKCE'),
    dpopBoundAccessTokens: boolean('dpopBoundAccessTokens').default(false),
    referenceId: text('referenceId'),
    metadata: jsonb('metadata'),
  },
  (t) => [index('oauthClient_userId_idx').on(t.userId)],
);

export const oauthResource = pgTable('oauthResource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('accessTokenTtl'),
  refreshTokenTtl: integer('refreshTokenTtl'),
  signingAlgorithm: text('signingAlgorithm'),
  signingKeyId: text('signingKeyId'),
  allowedScopes: text('allowedScopes').array(),
  customClaims: jsonb('customClaims'),
  dpopBoundAccessTokensRequired: boolean('dpopBoundAccessTokensRequired').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: timestamp('createdAt', { withTimezone: true }),
  updatedAt: timestamp('updatedAt', { withTimezone: true }),
  policyVersion: integer('policyVersion').default(1),
  metadata: jsonb('metadata'),
});

export const oauthClientResource = pgTable(
  'oauthClientResource',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    resourceId: text('resourceId')
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('createdAt', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('oauthClientResource_clientId_resourceId_uidx').on(t.clientId, t.resourceId),
    index('oauthClientResource_clientId_idx').on(t.clientId),
    index('oauthClientResource_resourceId_idx').on(t.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  'oauthRefreshToken',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('clientId')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('sessionId').references(() => session.id, { onDelete: 'set null' }),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    authorizationCodeId: text('authorizationCodeId'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requestedUserInfoClaims').array(),
    expiresAt: timestamp('expiresAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true }),
    revoked: timestamp('revoked', { withTimezone: true }),
    rotatedAt: timestamp('rotatedAt', { withTimezone: true }),
    rotationReplayResponse: text('rotationReplayResponse'),
    rotationReplayExpiresAt: timestamp('rotationReplayExpiresAt', { withTimezone: true }),
    authTime: timestamp('authTime', { withTimezone: true }),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    index('oauthRefreshToken_clientId_idx').on(t.clientId),
    index('oauthRefreshToken_sessionId_idx').on(t.sessionId),
    index('oauthRefreshToken_userId_idx').on(t.userId),
    index('oauthRefreshToken_authorizationCodeId_idx').on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  'oauthAccessToken',
  {
    id: text('id').primaryKey(),
    token: text('token').unique(),
    clientId: text('clientId')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    sessionId: text('sessionId').references(() => session.id, { onDelete: 'set null' }),
    userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    authorizationCodeId: text('authorizationCodeId'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requestedUserInfoClaims').array(),
    refreshId: text('refreshId').references(() => oauthRefreshToken.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expiresAt', { withTimezone: true }),
    createdAt: timestamp('createdAt', { withTimezone: true }),
    revoked: timestamp('revoked', { withTimezone: true }),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => [
    index('oauthAccessToken_clientId_idx').on(t.clientId),
    index('oauthAccessToken_sessionId_idx').on(t.sessionId),
    index('oauthAccessToken_userId_idx').on(t.userId),
    index('oauthAccessToken_authorizationCodeId_idx').on(t.authorizationCodeId),
    index('oauthAccessToken_refreshId_idx').on(t.refreshId),
  ],
);

export const oauthConsent = pgTable(
  'oauthConsent',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId')
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: 'cascade' }),
    userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requestedUserInfoClaims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true }),
    updatedAt: timestamp('updatedAt', { withTimezone: true }),
  },
  (t) => [
    index('oauthConsent_clientId_idx').on(t.clientId),
    index('oauthConsent_userId_idx').on(t.userId),
  ],
);

/** Replay ledger for `private_key_jwt` client assertions: the row id is the assertion jti, so a replay collides on the primary key and there is nothing else worth storing. */
export const oauthClientAssertion = pgTable('oauthClientAssertion', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
});
