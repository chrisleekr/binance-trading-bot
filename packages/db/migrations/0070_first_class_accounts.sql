-- First-class accounts: insert an account layer between the operator (users)
-- and profiles. Keys and binance_mode move from per-profile to per-account; a
-- profile now hangs off an account (profiles.account_id). audit_logs stays
-- operator-scoped (user_id -> operator_id, records who acted).
--
-- Greenfield / not-deployed: the backfill maps each operator to ONE account and
-- reparents its profiles + a single key pair. First-wins where the old
-- per-profile model allowed divergence (binance_mode, keys): the account takes
-- the earliest profile's binance_mode and the earliest key pair; the rest are
-- dropped. No production data. The runner wraps this file in one transaction.

-- 1. accounts table.
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users (id) on delete cascade,
  name text not null,
  binance_mode text not null,
  created_at timestamptz not null default now(),
  constraint accounts_binance_mode_chk check (binance_mode in ('test', 'live'))
);
create unique index if not exists accounts_owner_name_uniq on accounts (owner_id, name);

-- 2. One account per operator. binance_mode is first-wins from the operator's
-- profiles (earliest by created_at, id), defaulting to 'test' when the operator
-- has no profiles yet.
insert into accounts (owner_id, name, binance_mode)
select
  u.id,
  'Main',
  coalesce(
    (
      select p.binance_mode
      from profiles p
      where p.user_id = u.id
      order by p.created_at, p.id
      limit 1
    ),
    'test'
  )
from users u
where not exists (select 1 from accounts a where a.owner_id = u.id);

-- 3. profiles.user_id -> profiles.account_id (each operator has exactly one
-- account, so the join is unambiguous). Then drop the old column, its unique
-- index, and the per-profile binance_mode (now an account attribute).
alter table profiles add column if not exists account_id uuid;
update profiles p
set account_id = a.id
from accounts a
where a.owner_id = p.user_id and p.account_id is null;
alter table profiles alter column account_id set not null;
alter table profiles
  add constraint profiles_account_id_fkey foreign key (account_id) references accounts (id) on delete cascade;
drop index if exists profiles_user_name_uniq;
create unique index if not exists profiles_account_name_uniq on profiles (account_id, name);
alter table profiles drop constraint if exists profiles_binance_mode_chk;
alter table profiles drop column if exists binance_mode;
alter table profiles drop column if exists user_id;

-- 4. api_keys.profile_id -> api_keys.account_id. Reparent each key to its
-- profile's account, then enforce one key pair per account (first-wins: keep the
-- earliest-created key per account, delete the rest).
alter table api_keys add column if not exists account_id uuid;
update api_keys k
set account_id = p.account_id
from profiles p
where p.id = k.profile_id and k.account_id is null;
delete from api_keys k
using api_keys k2
where k.account_id = k2.account_id
  and (k2.created_at, k2.id) < (k.created_at, k.id);
alter table api_keys alter column account_id set not null;
alter table api_keys
  add constraint api_keys_account_id_fkey foreign key (account_id) references accounts (id) on delete cascade;
drop index if exists api_keys_profile_uniq;
create unique index if not exists api_keys_account_uniq on api_keys (account_id);
alter table api_keys drop column if exists profile_id;

-- 5. backtest_advisor_result.user_id -> account_id. The column carried operator
-- ids; re-point the values to the profile's account (profile_id is the real
-- query key; account_id carries no FK or index).
alter table backtest_advisor_result rename column user_id to account_id;
update backtest_advisor_result r
set account_id = p.account_id
from profiles p
where p.id = r.profile_id;

-- 6. audit_logs.user_id -> operator_id. Stays operator-scoped (records who
-- acted); values are unchanged, only the column and its indexes are renamed.
alter table audit_logs rename column user_id to operator_id;
drop index if exists audit_logs_by_user_recent;
drop index if exists audit_logs_by_user_profile_recent;
create index if not exists audit_logs_by_operator_recent
  on audit_logs (operator_id, created_at desc);
create index if not exists audit_logs_by_operator_profile_recent
  on audit_logs (operator_id, (payload ->> 'profileId'), created_at desc, id desc);
