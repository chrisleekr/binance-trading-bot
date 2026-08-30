import {
  needsAccountDeployedQuote as needsAccountDeployedQuoteForConfig,
  TechnicalsBundleConfigSchema,
  type AccountId,
  type ProfileId,
  type TechnicalsBundleConfig,
  type UserId,
} from '@app/contracts';
import { type Database, ProfileNotOwnedError, profileRepo, repo } from '@app/db';
import { mergeConfig } from '@app/strategy-core';

import type { ProfileTickContext } from 'tick/build-tick-input.js';
import { DEFAULT_BINANCE_WEIGHT_LIMIT_1M } from 'profile-bindings/index.js';

/**
 * Dependencies for {@link buildProfileTickContext}. Shape mirrors
 * {@link ProfileBindingsDeps} but adds the worker-owned `bundleProvider`
 * that is composed once at boot and reused per tick.
 */
export interface ProfileTickContextDeps {
  readonly db: Database;
  readonly bundleProvider: ProfileTickContext['bundleProvider'];
  readonly defaultWeightLimit1m?: number;
}

/**
 * Resolve a {@link ProfileTickContext} for the tick handler. Returns
 * `null` when the profile is missing or foreign (same swallow-into-null
 * pattern as `buildProfileBindings` so callers see one shape for "not
 * yours" + "doesn't exist"). The bundle provider is shared across every
 * call so a per-tick invocation is the only added cost.
 */
export const buildProfileTickContext = async (
  deps: ProfileTickContextDeps,
  operatorId: UserId,
  accountId: AccountId,
  profileId: ProfileId,
  symbol: string,
): Promise<ProfileTickContext | null> => {
  // `profileRepo` runs the single ownership check and throws
  // `ProfileNotOwnedError` for a missing-row OR cross-user profile;
  // both fold into the "no context" branch the tick handler interprets
  // as "profile disabled / gone". `p.profile.findById` can still return
  // `null` if the row is deleted between the scope check and the read.
  let p;
  try {
    p = await profileRepo(deps.db, operatorId, accountId, profileId);
  } catch (err) {
    if (err instanceof ProfileNotOwnedError) return null;
    throw err;
  }
  // findById and findForSymbol are independent — each needs only the proven
  // scope, not the other's result — so issue them as one parallel pair rather
  // than two serial round-trips on the hottest path in the system.
  const [profile, symbolRow] = await Promise.all([
    p.profile.findById(),
    p.profileSymbols.findForSymbol(symbol),
  ]);
  if (!profile) return null;
  // Each strategy is free to ignore candleInterval (single-interval
  // strategies, e.g.); operator-configurable intervals need this value
  // plumbed through. The strategy's configSchema is the source of
  // truth at the boundary; a missing field falls back to the schema default.
  const cfg = profile.config as { candleInterval?: unknown; technicals?: unknown };
  const candleInterval = typeof cfg.candleInterval === 'string' ? cfg.candleInterval : '1h';
  // Same strategy-agnostic parse as `candleInterval`: a strategy whose
  // schema carries no `technicals` block falls through to the schema defaults
  // (`useOnlyWithinMin: 2`, `ifExpires: 'do-not-buy'`) the bundle-builder
  // previously hardcoded. Parsed off the raw profile config rather than
  // the merged config below because the freshness gate is profile-
  // wide, not per-symbol (TTOverrideConfigSchema is strict and excludes
  // the field for the same reason candleInterval is excluded).
  const tvParsed = TechnicalsBundleConfigSchema.safeParse(cfg.technicals ?? {});
  const technicalsConfig: TechnicalsBundleConfig = tvParsed.success
    ? tvParsed.data
    : TechnicalsBundleConfigSchema.parse({});
  // Per-symbol config override: the effective config the strategy ticks
  // with is the profile config deep-merged with this symbol's stored
  // override. `mergeConfig` returns the base verbatim when there is no
  // override row (or `overrideConfig` is null), so a profile that has not
  // configured an override sees `profile.config` unchanged. candleInterval
  // is not part of the override surface (TTOverrideConfigSchema is strict
  // and excludes it), so the merged config keeps the profile-level value
  // that also drives the WS subscription above — no split-brain.
  // The API validates an override against the profile config at write
  // time; a later profile-config edit does not re-validate stored
  // overrides, so the strategy's own tick-boundary parsing is the backstop
  // for a since-invalidated merge.
  const config = mergeConfig(profile.config, symbolRow?.overrideConfig ?? null);
  // The cross-profile deployed-quote aggregate the tick assembler would
  // otherwise read every tick is needed by two consumers: an armed account
  // exposure cap (its headroom subtracts deployed) and percent-of-account entry
  // sizing (equity = cash + deployed). Detect either here (strategy-agnostic
  // duck-read, both config shapes) so the assembler skips that DB aggregate for
  // the default profile that uses neither.
  const needsAccountDeployedQuote = needsAccountDeployedQuoteForConfig(config);
  // Binance environment is per-account now (one key pair, one mode shared by
  // every profile under the account). A missing account (deletion race) folds
  // into the same "no context" null the ownership check uses.
  const binanceMode = await repo.accounts.binanceModeById(deps.db, accountId);
  if (!binanceMode) return null;
  return {
    operatorId,
    accountId,
    profileId,
    // Already proven by the `profileRepo` call above — exposed so the tick
    // handler threads this single ownership proof into the StatePort read/
    // commit instead of re-resolving and so the state write goes
    // through the typed `ProfileScope` repo. No extra DB read.
    scope: p.scope,
    symbol,
    strategyName: profile.strategyName,
    strategyVersion: profile.strategyVersion,
    config,
    bundleProvider: deps.bundleProvider,
    binanceMode,
    quoteAsset: profile.quoteAsset,
    weightLimit1m: deps.defaultWeightLimit1m ?? DEFAULT_BINANCE_WEIGHT_LIMIT_1M,
    candleInterval,
    technicalsConfig,
    needsAccountDeployedQuote,
  };
};
