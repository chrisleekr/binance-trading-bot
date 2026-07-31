// ProfileManager: single-replica orchestration of WS subscriptions per profile.
//
// Source-of-truth state:
//   - profileSymbols: Map<profileId, Set<symbol>>
//   - profilesUsing:  Map<symbol, Set<profileId>>          (the inverse index)
//   - profileMeta:    Map<profileId, { userId, candleInterval }>
//
// ProfileManager keeps the per-symbol `inverse` index ONLY for the
// `profilesUsing` event fan-out (which profiles to tick when a symbol's
// market event arrives). It no longer gates WS subscriptions on a per-symbol
// refcount: it forwards each profile's full symbol delta WITH its interval to
// the market hook, and the subscriptions-manager refcounts the actual WS
// streams by (symbol, interval). This is what lets two profiles trading the
// same symbol on different intervals each get their own interval subscribed.
//
// Lifecycle hooks (start/stop) drive the MarketDataSubscriber through a plain
// function dependency, so this module stays unit-testable without WS.
//
// The manager owns MARKET subscriptions and the membership set (listActive),
// NOT the account user-data stream: opening/closing that stream is
// `subscription-ownership`'s sole job, elected by HRW over listActive(). This
// split is what lets `reconcile()` mirror the fleet-global enabled set on every
// pod without every pod opening every account's user stream (#579).

import type { AccountId, ProfileId, UserId } from '@app/contracts';

export interface ProfileLoadRow {
  readonly userId: UserId;
  /** Operator (login/owner) the profile's account belongs to. Threaded into `scopeProfile` and the per-account Binance credential resolvers. */
  readonly operatorId: UserId;
  /** Binance account (one API key pair + one environment) the profile runs under. Keys every Redis namespace and credential resolve. */
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly symbols: readonly string[];
  readonly candleInterval: string;
  /**
   * Operator-configured Technicals intervals. Parsed from the strategy
   * config's `technicals.intervals[]` by the caller; the manager only
   * carries the resolved list. Empty when the operator cleared the
   * Technicals block.
   */
  readonly technicalsIntervals: readonly string[];
}

export interface MarketSubscriberHooks {
  addSymbols(symbols: readonly string[], candleInterval: string): Promise<void>;
  removeSymbols(symbols: readonly string[], candleInterval: string): Promise<void>;
}

export interface ProfileManagerDeps {
  readonly loadEnabledProfiles: () => Promise<readonly ProfileLoadRow[]>;
}

/**
 * Snapshot of one active (enabled, WS-subscribed) profile. Returned by
 * {@link ProfileManager.listActive} so the cron producers can enumerate
 * every running profile without each holding its own DB query.
 */
export interface ActiveProfile {
  readonly profileId: ProfileId;
  readonly userId: UserId;
  /** See {@link ProfileLoadRow.operatorId}. */
  readonly operatorId: UserId;
  /** See {@link ProfileLoadRow.accountId}. */
  readonly accountId: AccountId;
  readonly candleInterval: string;
  readonly symbols: readonly string[];
  /**
   * Operator-configured Technicals intervals (one entry per row in the
   * strategy's `technicals.intervals[]`). The `technicals-compute` cron
   * enumerates this list to drive distinct Redis writes per
   * (symbol, interval) pair. Empty when the operator cleared the list
   * (Technicals opted out for this profile).
   */
  readonly technicalsIntervals: readonly string[];
}

export interface ProfileManager {
  /**
   * Late-bind the market-subscription back-edge. Must be called during
   * boot before `start()`; the manager builds before the subscriptions
   * manager (which depends on the event-router, which depends on the
   * manager), so this closes that cycle without a forward-ref wrapper.
   */
  setMarket(hooks: MarketSubscriberHooks): void;
  start(): Promise<void>;
  enable(row: ProfileLoadRow): Promise<void>;
  disable(profileId: ProfileId): Promise<void>;
  /**
   * Converge the active set to the fleet-global enabled set from the DB.
   * Enables profiles not yet active, disables active profiles no longer in
   * `rows`, and converges symbols/interval/technicals on the rest (via the
   * idempotent {@link enable}). Membership-only: opening the account's
   * user-data stream is `subscription-ownership`'s job, driven off the
   * resulting {@link listActive}. Called on an interval so a subscribe/
   * unsubscribe that a single-consumer pipeline job applied on one pod
   * propagates fleet-wide — the multi-replica prerequisite (#579). No-op churn
   * at single replica where the pipeline job already applied the change.
   */
  reconcile(rows: readonly ProfileLoadRow[]): Promise<void>;
  /**
   * Resync a profile's WS subscriptions to a new symbol set, optionally on a
   * new candle interval. Omitting `candleInterval` keeps the current interval;
   * passing a different one re-subscribes the retained symbols to the new
   * interval (and drops them from the old) so a hot interval change applies
   * without a manual stop->start.
   */
  setSymbols(
    profileId: ProfileId,
    symbols: readonly string[],
    candleInterval?: string,
  ): Promise<void>;
  /**
   * Refresh the cached Technicals intervals for an already-enabled
   * profile so the `technicals-compute` cron picks them up on its
   * next tick. Returns `true` when the profile was found and updated,
   * `false` when it is not active (caller logs and moves on).
   */
  setTechnicalsIntervals(profileId: ProfileId, intervals: readonly string[]): boolean;
  profilesUsing(symbol: string): readonly ProfileId[];
  symbolsFor(profileId: ProfileId): readonly string[];
  userOf(profileId: ProfileId): UserId | undefined;
  /** Operator (owner) of an active profile's account, or undefined if not active. */
  operatorOf(profileId: ProfileId): UserId | undefined;
  /** Binance account an active profile runs under, or undefined if not active. */
  accountOf(profileId: ProfileId): AccountId | undefined;
  /**
   * Every currently-active profile with its user, interval, and symbols.
   * The enumeration primitive the entity-fan-out crons (alive,
   * technicals-compute, daily-ath, account-snapshot-safety) iterate each
   * tick; the worker is single-replica in v1.0, so an in-memory snapshot
   * is the source of truth without a DB round-trip.
   */
  listActive(): readonly ActiveProfile[];
  shutdown(): Promise<void>;
}

interface InternalState {
  userId: UserId;
  operatorId: UserId;
  accountId: AccountId;
  candleInterval: string;
  symbols: Set<string>;
  technicalsIntervals: readonly string[];
}

export const createProfileManager = (deps: ProfileManagerDeps): ProfileManager => {
  const profiles = new Map<ProfileId, InternalState>();
  const inverse = new Map<string, Set<ProfileId>>();

  // Market back-edge injected during boot via setMarket before start() runs.
  // Seeded with a loud sentinel so a wiring mistake throws at the first
  // enable/disable instead of silently no-opping (the old `ref.current?.`
  // optional-chain swallowed an unset port). One assign point, no per-call guard.
  const notWired = (hook: string, setter: string) => (): never => {
    throw new Error(`ProfileManager: ${hook} hook not wired (call ${setter} during boot)`);
  };
  let market: MarketSubscriberHooks = {
    addSymbols: notWired('Market', 'setMarket'),
    removeSymbols: notWired('Market', 'setMarket'),
  };

  // The inverse index is the per-symbol profile-fan-out set (profilesUsing).
  // WS-stream refcounting lives in the subscriptions-manager, so these only
  // maintain `inverse` membership.
  const indexUp = (symbol: string, profileId: ProfileId): void => {
    let bucket = inverse.get(symbol);
    if (!bucket) {
      bucket = new Set();
      inverse.set(symbol, bucket);
    }
    bucket.add(profileId);
  };

  const indexDown = (symbol: string, profileId: ProfileId): void => {
    const bucket = inverse.get(symbol);
    if (!bucket) return;
    bucket.delete(profileId);
    if (bucket.size === 0) inverse.delete(symbol);
  };

  const enable: ProfileManager['enable'] = async (row) => {
    // Already active: converge the live subscription to the operator's current
    // truth instead of no-opping. Making enable idempotent and DB-truth-driven
    // keeps the subscription from getting stuck until restart. Reuse setSymbols'
    // add-before-remove diff so there is one diff implementation.
    const existing = profiles.get(row.profileId);
    if (existing) {
      await setSymbols(row.profileId, row.symbols, row.candleInterval);
      setTechnicalsIntervals(row.profileId, row.technicalsIntervals);
      // Membership + market only; the account user-data stream is opened by
      // subscription-ownership off listActive(), so a converge never re-triggers
      // an onResync backfill here.
      return;
    }
    const symbols = new Set(row.symbols);
    profiles.set(row.profileId, {
      userId: row.userId,
      operatorId: row.operatorId,
      accountId: row.accountId,
      candleInterval: row.candleInterval,
      symbols,
      technicalsIntervals: row.technicalsIntervals,
    });
    for (const s of symbols) indexUp(s, row.profileId);
    if (symbols.size > 0) await market.addSymbols([...symbols], row.candleInterval);
    // Membership + market are set; subscription-ownership opens the account's
    // user-data stream on its next election over the updated listActive().
  };

  const disable: ProfileManager['disable'] = async (profileId) => {
    const state = profiles.get(profileId);
    if (!state) return;
    for (const s of state.symbols) indexDown(s, profileId);
    profiles.delete(profileId);
    if (state.symbols.size > 0)
      await market.removeSymbols([...state.symbols], state.candleInterval);
    // Membership dropped; subscription-ownership closes the account's user-data
    // stream on its next election once this profile leaves listActive().
  };

  const setSymbols: ProfileManager['setSymbols'] = async (
    profileId,
    nextSymbols,
    candleInterval,
  ) => {
    const state = profiles.get(profileId);
    if (!state) return;
    const newInterval = candleInterval ?? state.candleInterval;
    const oldInterval = state.candleInterval;
    const next = new Set(nextSymbols);
    const added: string[] = [];
    const released: string[] = [];
    const retained: string[] = [];
    for (const s of next) if (!state.symbols.has(s)) added.push(s);
    for (const s of state.symbols) if (!next.has(s)) released.push(s);
    for (const s of state.symbols) if (next.has(s)) retained.push(s);
    // Interval change on retained symbols: open the new interval's streams
    // BEFORE dropping the old so the shared 1m/1d/ticker (refcounted in the
    // subscriptions-manager) never flicker down to zero and back.
    if (newInterval !== oldInterval && retained.length > 0) {
      await market.addSymbols(retained, newInterval);
      await market.removeSymbols(retained, oldInterval);
    }
    // Symbol diff: new symbols claim the new interval; dropped symbols release
    // the interval they were subscribed on (the old one).
    if (added.length > 0) await market.addSymbols(added, newInterval);
    if (released.length > 0) await market.removeSymbols(released, oldInterval);
    for (const s of added) indexUp(s, profileId);
    for (const s of released) indexDown(s, profileId);
    state.symbols = next;
    state.candleInterval = newInterval;
  };

  const setTechnicalsIntervals: ProfileManager['setTechnicalsIntervals'] = (
    profileId,
    intervals,
  ) => {
    const state = profiles.get(profileId);
    if (!state) return false;
    state.technicalsIntervals = intervals;
    return true;
  };

  return {
    setMarket(hooks) {
      market = hooks;
    },
    async start() {
      const rows = await deps.loadEnabledProfiles();
      for (const r of rows) await enable(r);
    },
    enable,
    disable,
    async reconcile(rows) {
      // Disable-then-enable diff. `enable` is idempotent and converging (its
      // existing-profile branch reuses `setSymbols` so an unchanged row makes
      // zero market calls), so re-running it every interval is cheap. Disable
      // first so a profile removed from the enabled set drops its market subs
      // before the enables run.
      const keep = new Set(rows.map((r) => r.profileId));
      for (const id of [...profiles.keys()]) {
        if (!keep.has(id)) await disable(id);
      }
      for (const r of rows) await enable(r);
    },
    setSymbols,
    setTechnicalsIntervals,
    profilesUsing(symbol) {
      const bucket = inverse.get(symbol);
      return bucket ? Array.from(bucket) : [];
    },
    symbolsFor(profileId) {
      const s = profiles.get(profileId);
      return s ? Array.from(s.symbols) : [];
    },
    userOf(profileId) {
      return profiles.get(profileId)?.userId;
    },
    operatorOf(profileId) {
      return profiles.get(profileId)?.operatorId;
    },
    accountOf(profileId) {
      return profiles.get(profileId)?.accountId;
    },
    listActive() {
      return Array.from(profiles.entries(), ([profileId, s]) => ({
        profileId,
        userId: s.userId,
        operatorId: s.operatorId,
        accountId: s.accountId,
        candleInterval: s.candleInterval,
        symbols: Array.from(s.symbols),
        technicalsIntervals: s.technicalsIntervals,
      }));
    },
    async shutdown() {
      const ids = Array.from(profiles.keys());
      for (const id of ids) await disable(id);
    },
  };
};
