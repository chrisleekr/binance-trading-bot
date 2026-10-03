-- 0099_account_provider_email.sql
-- The email the identity provider reported for a single sign-on identity, so the Security page can say which provider account is linked. The identity itself stays issuer plus subject; this column is shown, never matched on, because the provider lets its owner change it. Nullable and additive: a pod on the previous release does not write it, and an identity linked before this migration fills it on its next single sign-on sign-in.
alter table "account" add column if not exists "providerEmail" text;
