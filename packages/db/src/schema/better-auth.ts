import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Better Auth's drizzle adapter resolves model names against this schema map by matching the table's *exported variable name*, not the SQL identifier; the variables therefore stay singular (`user`, `session`, `account`, `verification`) to match Better Auth's internal model names while the SQL tables (created in migration 0007_better_auth.sql and upgraded for the 1.7 account identity in 0087_better_auth_account_issuer.sql) also use the singular camelCase columns Better Auth emits by default.
 *
 * Better Auth owns these rows. Outside its API, only `repo.authIdentity` touches them, for the few things Better Auth cannot do: counting operators for the single-operator gate, and the revocations and credential repair that the reset command and restore must perform without constructing an auth instance (so a hung identity provider cannot block recovery), and the retention sweep of expired `verification` rows. Any other code goes through the Better Auth API.
 */
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  name: text('name'),
  image: text('image'),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
    // Written through Better Auth `session.additionalFields` (migration 0098). A session whose epoch is below auth_security_settings.security_epoch was issued before a sign-out-everywhere and is refused.
    securityEpoch: integer('securityEpoch').notNull().default(0),
    signInMethod: text('signInMethod'),
    // When the person last proved who they are; for single sign-on, the identity provider's auth_time.
    interactiveAuthenticatedAt: timestamp('interactiveAuthenticatedAt', { withTimezone: true }),
  },
  (t) => [
    index('session_user_id_idx').on(t.userId),
    index('session_expires_at_idx').on(t.expiresAt),
  ],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    providerId: text('providerId').notNull(),
    // Nullable since Better Auth 1.7.3 stopped writing it, and migration 0096 relaxed the column to match. A NOT NULL here makes the adapter's own schema check refuse every insert into `account`, which is every sign-up. The column itself survives until the rollout that removes 1.7.2 from the fleet.
    issuer: text('issuer'),
    accountId: text('accountId').notNull(),
    password: text('password'),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
    scope: text('scope'),
    // The email the identity provider reported, for display only. Written through Better Auth's `account.additionalFields`; never used to match a sign-in, because the provider lets its owner change it.
    providerEmail: text('providerEmail'),
    createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Back to the 1.6 identity Better Auth 1.7.3+ recognises an account by.
    uniqueIndex('account_provider_uniq').on(t.providerId, t.accountId),
    index('account_user_id_idx').on(t.userId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);
