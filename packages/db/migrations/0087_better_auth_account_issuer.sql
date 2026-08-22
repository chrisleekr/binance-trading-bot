-- Better Auth 1.7 keys provider identities by (issuer, accountId). This app has only ever enabled email-and-password auth, so every existing account must be a credential account. Stop rather than inventing an issuer for unexpected provider data.
do $$
begin
  if exists (select 1 from "account" where "providerId" <> 'credential') then
    raise exception 'Better Auth 1.7 migration supports only credential accounts; map unexpected providerId values before deploying';
  end if;
end $$;

alter table "account" add column if not exists issuer text;
drop index if exists account_provider_uniq;

-- Better Auth 1.7 defines a credential identity as local:credential plus the linked user's stable id. Rewriting accountId is deliberate even though the 1.6 value normally already matches userId.
update "account"
set issuer = 'local:credential',
    "accountId" = "userId";

do $$
begin
  if exists (
    select issuer, "accountId"
    from "account"
    group by issuer, "accountId"
    having count(*) > 1
  ) then
    raise exception 'Better Auth account identity collision; reconcile duplicate issuer/accountId rows before deploying';
  end if;
end $$;

alter table "account" alter column issuer set not null;
create unique index if not exists "account_issuer_accountId_uidx"
  on "account" (issuer, "accountId");
