-- Orders are account-domain, not profile-domain: a Binance order id is unique per
-- ACCOUNT, the user-data stream that reconciles it is per ACCOUNT, and the order
-- keeps resting on the exchange whether or not the profile that placed it still
-- exists. Cascading a profile delete into `orders` destroyed the only record of a
-- still-live exchange order. Orders now hang off the account and merely REFERENCE
-- a profile; deleting a profile DETACHES its orders (profile_id -> NULL) and they
-- stay reconcilable.

-- The backfill is TOTAL, which is what lets the SET NOT NULL below be
-- unconditional: until this migration `profile_id` was NOT NULL with an FK to
-- `profiles`, so every existing row has a profile and every profile has an account.
-- No row can miss the join, and none can be left behind.
ALTER TABLE orders ADD COLUMN account_id uuid;
UPDATE orders o SET account_id = p.account_id FROM profiles p WHERE p.id = o.profile_id;
ALTER TABLE orders ALTER COLUMN account_id SET NOT NULL;

-- CASCADE, not SET NULL: deleting an account cascades to profiles, and without a
-- cascade here that delete would fail on this FK.
ALTER TABLE orders ADD CONSTRAINT orders_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;

CREATE INDEX orders_account_binance_order_id ON orders (account_id, binance_order_id);

-- The profile FK was created by an earlier migration without an explicit name;
-- look it up rather than guess it.
DO $$
DECLARE fk text;
BEGIN
  SELECT c.conname INTO fk FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'orders'::regclass AND c.contype = 'f' AND a.attname = 'profile_id';
  IF fk IS NOT NULL THEN EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', fk); END IF;
END $$;

ALTER TABLE orders ALTER COLUMN profile_id DROP NOT NULL;
ALTER TABLE orders ADD CONSTRAINT orders_profile_id_fkey
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE SET NULL;

-- `orders_one_live_per_intent` needs no change: Postgres treats NULLs as distinct
-- in a unique index, so a detached row never blocks a new live slot.
