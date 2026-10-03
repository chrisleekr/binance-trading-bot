-- 0096_better_auth_account_issuer_optional.sql
-- Better Auth 1.7.0 through 1.7.2 required an `issuer` column on `account` and a
-- unique index on (issuer, accountId); 1.7.3 removed that requirement and went
-- back to the 1.6 identity, which is (providerId, accountId). Migration 0087
-- added the column for the version this repo was on at the time.
--
-- On 1.7.3 and later the library never writes `issuer`, so a NOT NULL column
-- rejects EVERY sign-up and account link with a constraint violation. That is
-- not a warning: it is a 500 on the only route that creates the master account.
--
-- Source: Better Auth "1.7 upgrade guide" — "Better Auth 1.7.0 through 1.7.2
-- added a required `issuer` column to the `account` table and a unique index on
-- `issuer` and `accountId`. Better Auth 1.7.3 removes that requirement." and
-- "a NOT NULL column rejects every sign-up and account link until you relax it".
--
-- EXPAND ONLY, and the reason is the rollout order rather than taste. The
-- migration hook runs before the new pod starts, so between the two a pod still
-- running 1.7.2 is writing `issuer` on every sign-up. Dropping the column here
-- would 42703 that pod. Relaxing the constraint is compatible with both: the old
-- code still writes a value, the new code omits it. Dropping the column is a
-- later migration, once nothing writes it.

drop index if exists "account_issuer_accountId_uidx";

alter table "account" alter column issuer drop not null;

-- Restore the 1.6 identity 0087 dropped, under the SAME name and the same pair
-- it dropped: 0087's `drop index if exists account_provider_uniq` is what
-- removed it, so this is a restoration rather than a new constraint appearing
-- on a table that never had one.
--
-- No existing row can violate it. 0087 set `accountId = userId` for every row
-- and this deployment has only ever had credential accounts, so (providerId,
-- accountId) is (credential, userId); 0087 then raised on any duplicate
-- (issuer, accountId), and with `issuer` a single constant that check WAS a
-- uniqueness check on accountId. A 1.7.2 pod still writing during the rollout
-- window writes the same pair shape, so it cannot introduce one either.
--
-- Not CONCURRENTLY: the runner applies each file inside one transaction and
-- `create index concurrently` cannot run in one. The plain form takes a lock
-- that blocks writes to `account` for the duration, which on a single-operator
-- table of a few rows is immaterial and is the same lock the original index
-- was created under.
create unique index if not exists account_provider_uniq on "account"("providerId", "accountId");
