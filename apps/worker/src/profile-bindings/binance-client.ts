// Per-profile Binance REST client construction.
//
// Isolated from `index.ts` so that:
//   1. `buildProfileBindings` can be unit-tested by stubbing this single
//      factory rather than `@app/binance` at module level.
//   2. A future swap (mode override for canary testing, ratelimit
//      decorator) lands here without touching the bindings factory.

import {
  createBinanceRest,
  type BinanceMode,
  type BinanceRestClient,
  type WeightGovernor,
} from '@app/binance';

/**
 * Inputs that uniquely identify a per-profile REST client. `mode` chooses
 * the URL host (live vs testnet); `apiKey`/`secretKey` are read straight
 * from the `api_keys` row and forwarded unchanged so the HMAC signature
 * stays profile-scoped at this boundary — no caching, no rewriting.
 *
 * `weightGovernor` is an optional shared admission control across every
 * profile's client. Wiring all profiles to one governor keeps the per-IP
 * Binance budget honest no matter how many profiles a single worker serves.
 */
export interface BuildBinanceClientInput {
  readonly mode: BinanceMode;
  readonly apiKey: string;
  readonly secretKey: string;
  readonly weightGovernor?: WeightGovernor;
}

/**
 * Construct a `BinanceRestClient` bound to a single profile's credentials.
 * Thin wrapper over `createBinanceRest`; exists so that callers consume a
 * narrow factory shape instead of leaking `CreateBinanceRestOptions` (with
 * its `fetchImpl`/`clock` knobs that bindings code has no business setting).
 */
export const buildBinanceClient = (input: BuildBinanceClientInput): BinanceRestClient =>
  createBinanceRest({
    mode: input.mode,
    credentials: { apiKey: input.apiKey, secretKey: input.secretKey },
    ...(input.weightGovernor ? { weightGovernor: input.weightGovernor } : {}),
  });
