-- Persist the verify-key result so it is not silently discarded. The worker's
-- verify-key job validates the saved API key against Binance (getAccount), but
-- the outcome was only logged, so a non-working key (bad secret, missing
-- permission, non-allowlisted IP) looked identical to a working one and trades
-- then silently never executed. These columns let the worker record the result
-- and the API surface it to the operator (#366). Existing rows default to
-- 'pending' until the next verify-key run.

alter table api_keys
  add column verification_status text not null default 'pending',
  add column verified_at timestamptz,
  add column verification_error text;
