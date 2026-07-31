-- Operator display-timezone preference. Account-global (the single master
-- user row), applied by the web app to every rendered timestamp. NOT NULL with
-- a 'UTC' default so existing rows and any insert that omits it keep UTC.
alter table users add column if not exists timezone text not null default 'UTC';
