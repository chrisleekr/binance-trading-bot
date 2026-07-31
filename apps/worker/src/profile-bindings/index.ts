// LiveExecutor `resolveProfile` DI seam: turns one `(operatorId, accountId,
// profileId)` triple into a fully wired `ProfileExecutorBindings`, or returns
// `null` if the profile is missing / foreign / the account has no api-key
// configured yet. Credentials are per-ACCOUNT (one key pair, one environment
// shared by every profile under the account), so they are resolved by accountId.

import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { BinanceMode } from '@app/binance';
import {
  accountRepoFromScope,
  repo,
  toAccountScope,
  type Database,
  type ProfileRepo,
  type ProfileScope,
  ProfileNotOwnedError,
  profileRepo,
  profileRepoFromScope,
} from '@app/db';

import type { ProfileExecutorBindings } from 'executor/live-executor.js';

import { buildBinanceClient } from './binance-client.js';
import { buildPersistence } from './persistence.js';
import type { ProfileResolved } from './resolved-config.js';

/**
 * Per-account spot weight ceiling. Binance documents 1200 weight/minute on
 * the spot API for IP+UID-keyed callers; the executor uses this as the
 * throttle threshold. Externalised so a future env override can land
 * without touching every caller, but in v1.0 the constant matches what
 * `packages/strategy/core` already assumes.
 */
export const DEFAULT_BINANCE_WEIGHT_LIMIT_1M = 1200;

/**
 * Dependencies needed to produce a bindings closure. `db` is the typed
 * Drizzle handle; `defaultWeightLimit1m` lets callers override the
 * per-account ceiling for tests. `clock` is forwarded to
 * `buildPersistence` so order-row timestamps stay deterministic in
 * tests without leaking into the public bindings type. `logger` is also
 * forwarded so the persistence layer can surface a `closeOrder`
 * zero-match (silent-failure guard, see CLAUDE.md "no silent failures").
 */
export interface ProfileBindingsDeps {
  readonly db: Database;
  readonly defaultWeightLimit1m?: number;
  readonly clock?: { nowMs(): number };
  readonly logger?: { warn(obj: Readonly<Record<string, unknown>>, msg: string): void };
}

/**
 * Narrow the persisted `binance_mode` text column to the union
 * `'live' | 'test'`. The DB CHECK constraint enforces this at write time,
 * but trusting the type at the boundary would silently widen if the
 * constraint ever drifted; throwing here is the loud-fail behaviour
 * CLAUDE.md requires for unexpected runtime state.
 */
export const asBinanceMode = (raw: string): BinanceMode => {
  if (raw !== 'live' && raw !== 'test') {
    throw new Error(`profile.binanceMode out of range: ${JSON.stringify(raw)}`);
  }
  return raw;
};

/**
 * The bindings build proper, once ownership is settled. Both entry points below
 * differ only in how they obtain the scoped repo — proving ownership or being
 * handed the proof — so the wiring lives here exactly once.
 *
 * Missing api-key row → `null` (the operator hasn't configured the account
 * yet; we refuse to execute rather than throwing, mirroring the "disabled?"
 * branch of the tick handler). Anything else (DB error, schema drift) throws so
 * the worker's BullMQ wrapper retries + DLQs on repeated failure.
 *
 * `profile.findById` runs on BOTH paths as an existence guard: a profile
 * deleted mid-tick MUST make the tick skip the order. Dispose-profile chains on
 * `chain.run(profileId)` while the tick chains on `chain.run(profileId:symbol)`
 * — different keys, so they interleave; without this null check the tick would
 * place an order for a deleting profile (orphan Binance order / FK-DLQ).
 *
 * `resolved` is the tick path's already-read config snapshot (quoteAsset +
 * weightLimit1m). When present the config VALUES come from it (single-sourced
 * from the decision snapshot), not from the freshly-read row; the read still
 * happens, but only for existence. `mode` and the credentials are read fresh
 * regardless — binance_mode is mutable, and stale creds would build the wrong
 * REST client.
 *
 * Cost: three DB selects (profile existence + account key + account mode), issued
 * concurrently, plus one `createBinanceRest`. `LiveExecutor.applyAll` memoises
 * the call for the span of ONE `applyAll`, so a multi-decision tick resolves the
 * profile once — but the memo is rebuilt per invocation, so every order-emitting
 * tick pays the selects again. That is why they run in parallel rather than
 * relying on the memo to amortise them.
 */
const bindingsFromRepo = async (
  p: ProfileRepo,
  deps: ProfileBindingsDeps,
  accountId: AccountId,
  resolved?: ProfileResolved,
): Promise<ProfileExecutorBindings | null> => {
  // Three independent reads: the profile existence guard (see the deletion-race
  // note above) and the account's credentials + environment, which are keyed on
  // `accountId` alone. None consumes another's result, so they are issued
  // together — this sits directly ahead of `binance.placeOrder`, so the saved
  // round-trips come straight off the order's latency budget. Every branch below
  // still refuses on a missing row; parallelising only means a read that would
  // have been short-circuited is issued anyway.
  const [profile, apiKey, modeRaw] = await Promise.all([
    p.profile.findById(),
    repo.apiKeys.findByAccountId(deps.db, accountId),
    repo.accounts.binanceModeById(deps.db, accountId),
  ]);
  if (!profile || !apiKey || !modeRaw) return null;

  // Config values come from the tick's snapshot when supplied, else from the row.
  const config: ProfileResolved = resolved ?? {
    quoteAsset: profile.quoteAsset,
    weightLimit1m: deps.defaultWeightLimit1m ?? DEFAULT_BINANCE_WEIGHT_LIMIT_1M,
  };

  const mode = asBinanceMode(modeRaw);
  const binance = buildBinanceClient({
    mode,
    apiKey: apiKey.key,
    secretKey: apiKey.secret,
  });

  // Order reconciliation by Binance id is account-domain. `toAccountScope` widens
  // the proof `scopeProfile` already made — no second ownership query.
  const persistence = buildPersistence(p, accountRepoFromScope(toAccountScope(p.scope)), {
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  return {
    mode,
    binance,
    weightLimit1m: config.weightLimit1m,
    quoteAsset: config.quoteAsset,
    persistence,
  };
};

/**
 * Resolve the live bindings from an already-proven {@link ProfileScope}.
 *
 * The tick path proves ownership once in `buildProfileTickContext`; handing
 * that proof here is what keeps CLAUDE.md's "exactly once" literal — the
 * executor no longer re-derives a scope from a `(userId, profileId)` whose
 * ownership was established moments earlier. Returns `null` when the profile
 * row vanished between the proof and this read (the existence guard against a
 * mid-tick dispose), or when no api-key is configured yet.
 *
 * `resolved` carries the config values the same tick already read; passing it
 * single-sources those scalars from the decision snapshot instead of the
 * freshly-read row. The existence read still runs (mode + credentials too).
 * The context-free pipeline path omits it and sources the config from the row.
 */
export const buildProfileBindingsFromScope = (
  deps: ProfileBindingsDeps,
  scope: ProfileScope,
  resolved?: ProfileResolved,
): Promise<ProfileExecutorBindings | null> =>
  bindingsFromRepo(profileRepoFromScope(scope), deps, scope.accountId, resolved);

/**
 * Resolve the live bindings for one profile, proving ownership first.
 *
 *   - Missing or foreign profile → `null` (so the executor logs and skips).
 *   - Missing api-key row → `null` (operator hasn't configured the
 *     account yet; we refuse to execute rather than throwing, mirroring
 *     the "disabled?" branch of the tick handler).
 *   - Anything else (DB error, schema drift) → throws; the worker's
 *     BullMQ wrapper turns that into a retry + DLQ on repeated failure.
 *
 * `ProfileNotOwnedError` from the typed repo layer is caught and folded
 * into the `null` branch so callers see one shape for "not yours" and
 * "doesn't exist".
 *
 * Callers already holding a proven scope (the tick path) use
 * {@link buildProfileBindingsFromScope} and skip the ownership query.
 */
export const buildProfileBindings = async (
  deps: ProfileBindingsDeps,
  operatorId: UserId,
  accountId: AccountId,
  profileId: ProfileId,
): Promise<ProfileExecutorBindings | null> => {
  let p;
  try {
    p = await profileRepo(deps.db, operatorId, accountId, profileId);
  } catch (err) {
    if (err instanceof ProfileNotOwnedError) return null;
    throw err;
  }
  return bindingsFromRepo(p, deps, accountId);
};
