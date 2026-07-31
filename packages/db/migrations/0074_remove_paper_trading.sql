-- Disable any profile relying on demo_mode to NOT place real orders, BEFORE
-- dropping the column. Same transaction so a simulated profile can never be
-- silently promoted to live trading.
UPDATE profiles SET enabled = false WHERE demo_mode = true;
ALTER TABLE profiles DROP COLUMN demo_mode;
DROP TABLE simulated_orders;
