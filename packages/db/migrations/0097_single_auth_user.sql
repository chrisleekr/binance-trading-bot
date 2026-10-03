-- 0097_single_auth_user.sql
-- The deployment has exactly one operator. Until now that rule lived only in a route-level count check, and Better Auth's own `/sign-up/email` endpoint was reachable behind the auth router's catch-all, so a second row in "user" (and with it a second operator holding its own accounts) could be created by anyone who could reach the API. The application now refuses a second user in three places; this index is the one no application bug can bypass.
--
-- Stop, rather than pick a survivor, when two users already exist. Choosing which one is the real operator is a human decision, and a second user is itself evidence that the old sign-up path was used; the operator should see that before anything is deleted.

do $$
begin
  if (select count(*) from "user") > 1 then
    raise exception 'More than one sign-in user exists. This deployment allows exactly one operator, and a second user means the unguarded sign-up path was used. Inspect "user" and "account" (created timestamps, emails), delete the intruding user with: delete from "user" where id = <id>; then re-run migrations.';
  end if;
end $$;

-- A unique index over a constant expression admits at most one row: every row indexes the same key.
create unique index if not exists user_single_operator_uidx on "user" ((true));
