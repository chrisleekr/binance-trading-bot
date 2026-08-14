// Redis key catalogue for the executor. Builders return the byte-exact
// keys read by the projection / API / cron layers; the assertions in
// `__tests__/executor/redis-namespace.test.ts` pin every entry so a
// suffix change cannot silently desync writer and reader.

import type { AccountId, ProfileId } from '@app/contracts';
import type { BinanceMode } from '@app/binance';
import {
  accountPermissionsKey,
  auditStreamKey,
  eventsChannelKey,
  eventsSeqKey,
  eventsStreamKey,
  GLOBAL_KEYS,
  openOrdersKey,
  profileKey,
} from '@app/db';

// The events/audit stream keys cross the worker→api process boundary, so they
// delegate to the shared `@app/db` catalogue (the single source the api reader
// also imports) rather than re-deriving the grammar here.
type KeyBuilder = (accountId: AccountId, profileId: ProfileId) => string;
export const buildAuditStreamKey: KeyBuilder = auditStreamKey;
export const buildEventsChannel: KeyBuilder = eventsChannelKey;
export const buildEventsStreamKey: KeyBuilder = eventsStreamKey;
export const buildEventsSeqKey: KeyBuilder = eventsSeqKey;

export const buildWeightKey = (
  accountId: AccountId,
  profileId: ProfileId,
  minuteBucket: number,
): string => profileKey({ accountId, profileId }, 'binanceWeight', minuteBucket);

// Account-domain: the open-orders snapshot is one order book per Binance key
// pair, shared by every profile under the account, so the key carries no profile
// segment. Delegates to the shared `@app/db` catalogue so the account reader and
// the worker writer agree on the bytes.
export const buildOpenOrdersKey = (accountId: AccountId, symbol: string): string =>
  openOrdersKey(accountId, symbol);

// Account-domain: Binance permission tags belong to the key pair, so like the
// open-orders snapshot this key carries no profile segment. Written by every
// `/account` fetch, read by the pre-flight tradability check.
export const buildAccountPermissionsKey = (accountId: AccountId): string =>
  accountPermissionsKey(accountId);

export const buildAccountInfoKey = (accountId: AccountId, profileId: ProfileId): string =>
  profileKey({ accountId, profileId }, 'accountInfo');

export const buildDustEligibleKey = (accountId: AccountId, profileId: ProfileId): string =>
  profileKey({ accountId, profileId }, 'dustEligible');

export const buildKillSwitchKey = (accountId: AccountId, profileId: ProfileId): string =>
  profileKey({ accountId, profileId }, 'killSwitch');

// Per-(profile, symbol) pause flag. The per-coin "Pause" control sets this key;
// the tick reads it on the snapshot pipeline and freezes ALL new buy+sell
// decisions for that symbol while it is present. Scoped per symbol (unlike the
// profile-wide killSwitch) so pausing one coin never touches the others.
export const buildDisableActionKey = (
  accountId: AccountId,
  profileId: ProfileId,
  symbol: string,
): string => profileKey({ accountId, profileId }, 'disableAction', symbol);

// Per-(profile, symbol) strategy-state Redis key — the hot copy the tick and
// the reset-grid pipeline job reconcile against the durable `symbol_states` PG
// row. Keyed per symbol because the tick handler's `chainByKey` serialises per
// (profileId, symbol).
export const buildSymbolStateKey = (
  accountId: AccountId,
  profileId: ProfileId,
  symbol: string,
): string => profileKey({ accountId, profileId }, 'symbolState', symbol);

export const buildOrderRefusalKey = (
  accountId: AccountId,
  profileId: ProfileId,
  symbol: string,
): string => profileKey({ accountId, profileId }, 'orderRefusal', symbol);

// Operational metadata for the dashboard tick-health chips. Written by
// `tick-handler` after every tick attempt, read by the profile-aggregate
// projection. Separate from `symbolState` so the strategy state blob
// (owned by the pure strategy.tick output) never has to carry runtime
// telemetry alongside it.
export const buildProfileTickMetaKey = (accountId: AccountId, profileId: ProfileId): string =>
  profileKey({ accountId, profileId }, 'profileTickMeta');

// Epoch-ms of the profile's most recent user-data-stream event. The
// EventRouter stamps it on every user event; the `account-snapshot-safety`
// cron reads it to decide whether the WS is alive (recent event) or has
// gone quiet and the account needs a REST refresh.
export const buildUserStreamEventKey = (accountId: AccountId, profileId: ProfileId): string =>
  profileKey({ accountId, profileId }, 'userStreamEvent');

// Exchange-wide symbol filters, namespaced by Binance mode. Populated by the
// `exchange-info-refresh` cron every 5 min and read on every tick. Delegates to
// the shared `@app/db` catalogue so the mode → keyspace grammar (and the
// live/test glob disjointness) lives in one place the API reader also imports.
// `mode` is required for the same reason it is on the catalogue helper: a
// defaulted `live` silently reads production filters for a testnet account.
export const buildSymbolInfoKey = (symbol: string, mode: BinanceMode): string =>
  GLOBAL_KEYS.symbolInfo(symbol, mode);

// Marks that the previous tick for this (profile, symbol) failed an order and
// deliberately did NOT advance its state, so this tick is the retry. Purely a
// VISIBILITY flag: the retry itself is driven by the un-advanced state, not by
// this key. Self-expiring, so a profile that stops ticking cannot leave it set.
// Lives here, not in the tick handler, because the tick snapshot pipeline reads
// it and the handler writes it.
export const buildOrderRearmKey = (profileId: ProfileId, symbol: string): string =>
  `order-rearm:${profileId}:${symbol}`;
