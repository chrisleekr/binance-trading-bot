// Which base assets discovery must never auto-add, read from Binance itself.
//
// Discovery hunts 24h gainers. A stablecoin or a fiat currency has no gainer signal to read: its ordinary peg noise clears an inclusive `changeMinPercent >= 0` hurdle, so it is admitted on nothing and then sits in a slot doing nothing. Every other ticker stage is an operator setting; this one is a fact about the asset, so it is not configurable and has no blocklist entry.
//
// The classification comes from Binance's own product metadata and nowhere else. A registry of asset names in this repo is stale the day a new stablecoin lists, and no price or name heuristic separates a peg from a coin that happens to trade near a dollar. Two disjoint routes carry it:
//
// - `tags` containing `stablecoin`, read off the row whose BASE is that asset.
// - the `q` (QUOTE) side of a row Binance marks `pm`/`pn` = `FIAT`. The quote is the fiat leg; the base of such a row is an ordinary coin (`ADAEUR` is ADA priced in euros), so reading `b` here would veto hundreds of perfectly tradable assets.
//
// Neither route is redundant. `EURUSDT` carries EMPTY tags, so EUR is reachable only through the second, and a stablecoin quoted only against USDT is reachable only through the first. Neither is a fallback for the other either: each is checked for liveness on its own, because the fiat route alone always yields a dozen national currencies and would keep a merged floor satisfied while the stablecoin route was dead.
//
// The feed is a different service from the REST API the rest of the worker talks to, and it is unauthenticated, so it is treated as untrusted: hand-projected over its short keys, size-capped, then cross-checked against live exchangeInfo before any cycle acts on it. Missing, stale, malformed, or incomplete classification aborts the profile cycle — no add and no remove — because a policy that silently degrades to "nothing is a stablecoin" is exactly the failure it exists to prevent.

import { SymbolName } from '@app/contracts';
import type { Logger } from 'pino';
import type { SymbolAdmission } from './symbol-admission.js';

const PRODUCTS_URL =
  'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true';

const FETCH_TIMEOUT_MS = 15_000;

/**
 * How long one fetched classification may be reused. Discovery wakes every 60s and each profile
 * runs on its own refresh period, so a per-wake fetch would hammer a public endpoint that changes
 * about as often as a coin lists. Five minutes bounds how long a newly listed stablecoin can be
 * admitted; the exchangeInfo cross-check bounds the far worse case, a feed that stopped moving.
 */
export const SNAPSHOT_MAX_AGE_MS: number = 5 * 60_000;

/** The tag Binance puts on every product row whose BASE asset is a stablecoin. */
const STABLECOIN_TAG = 'stablecoin';

/** The `pm`/`pn` value marking a row whose QUOTE side is a fiat currency. */
const FIAT_MARKET = 'FIAT';

/** Roughly ten times the observed live payload. A cheap early-out only: it reads `content-length`, which a chunked response omits entirely and a compressed one reports in encoded bytes, so it rejects an obviously-wrong body without bounding the allocation. The abort timeout is what always bounds a body the upstream refuses to size honestly. */
const MAX_DECLARED_BODY_BYTES = 8 * 1024 * 1024;

/** Roughly ten times the observed live row count, for the same reason. */
const MAX_ROWS = 20_000;

/**
 * One product row, narrowed to the short keys this module reads. The live payload carries ~35 keys
 * per row; the rest are none of discovery's business and are dropped at the projection boundary.
 */
export interface RawProduct {
  /** Symbol, e.g. `RLUSDUSDT`. */
  readonly s: string;
  /** Trading status. The feed lists only `TRADING` products, which is what makes the exchangeInfo cross-check a completeness check rather than a status comparison. */
  readonly st: string;
  /** Base asset, the side a stablecoin `tags` entry describes. */
  readonly b: string;
  /** Quote asset, the side a `FIAT` parent-market marks as a currency. */
  readonly q: string;
  /** Parent market. `FIAT` (with `pn`) marks the quote as a fiat currency. */
  readonly pm: string;
  /** Parent-market name; carries the same `FIAT` marking as `pm`, and both are required to agree. */
  readonly pn: string;
  /** Asset classification tags, e.g. `['stablecoin']`. Empty on plenty of legitimate rows. */
  readonly tags: readonly string[];
}

/** The classification one fetch of the product feed yields. */
export interface AssetPolicy {
  /** Base assets Binance currently classifies stablecoin or fiat. Discovery admits none of them, on any quote. */
  readonly stablecoinOrFiatBases: ReadonlySet<string>;
  /** The tag route's yield on its own. Kept separate from the merged set because the two routes fail independently, and a merged non-empty check cannot tell a live route from a dead one. */
  readonly taggedStablecoinBases: ReadonlySet<string>;
  /** The parent-market route's yield on its own, for the same reason. */
  readonly fiatQuoteAssets: ReadonlySet<string>;
  /** Every symbol the feed reported, for the completeness cross-check against live exchangeInfo. */
  readonly tradingSymbols: ReadonlySet<string>;
}

const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

/**
 * Project one untrusted payload into the rows this module understands, dropping anything that does not carry all seven short keys with the right types.
 *
 * Hand-written rather than a zod schema on purpose: `@app/contracts` owns zod for OUR wire contracts, and every untrusted Binance payload in the worker is hand-projected the same way (`exchange-info-refresh`'s `projectSymbol`). A skipped row is not silently tolerated either — it shrinks `tradingSymbols`, and {@link validateAssetPolicy} then refuses the whole snapshot for incompleteness.
 *
 * @param body - The parsed JSON body of the product feed, entirely unvalidated. A non-object, a missing `data`, or a `data` that is not an array all yield no rows; a `data` longer than the row cap THROWS instead, since a payload that size is not this feed and truncating it would present a partial classification as a whole one.
 * @returns The rows that carried every key this module reads, in payload order.
 * @throws When `data` holds more rows than the cap allows.
 */
export const projectProducts = (body: unknown): RawProduct[] => {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  // Throws rather than truncating: a silent cut would shrink the symbol set, which the completeness cross-check would then report as a product/exchangeInfo mismatch and send the operator hunting the wrong fault.
  if (data.length > MAX_ROWS) {
    throw new Error(`discovery asset-policy: ${data.length} product rows exceeds ${MAX_ROWS}`);
  }
  const out: RawProduct[] = [];
  for (const row of data) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r['s'] !== 'string' ||
      typeof r['st'] !== 'string' ||
      typeof r['b'] !== 'string' ||
      typeof r['q'] !== 'string' ||
      typeof r['pm'] !== 'string' ||
      typeof r['pn'] !== 'string' ||
      !isStringArray(r['tags'])
    ) {
      continue;
    }
    out.push({
      s: r['s'],
      st: r['st'],
      b: r['b'],
      q: r['q'],
      pm: r['pm'],
      pn: r['pn'],
      tags: r['tags'],
    });
  }
  return out;
};

/**
 * Derive the base-asset veto set from projected product rows.
 *
 * Scoped to the BASE asset rather than the symbol so the veto holds across every pairing: USDC is refused whether it is offered as `USDCUSDT` or `USDCTRY`, and a stablecoin whose own row lost its tag is still caught by any other row that carries it.
 *
 * The two routes are returned separately as well as merged. They fail independently, and only the per-route yields can distinguish a healthy classification from one where a route has gone silently dead.
 *
 * @param rows - Projected product rows; only `TRADING` ones are read, since a non-trading row describes a market discovery could not enter anyway.
 * @returns The classification: the merged veto set, each route's yield on its own for the liveness checks, and the symbol set the completeness check compares against exchangeInfo.
 */
export const deriveAssetPolicy = (rows: readonly RawProduct[]): AssetPolicy => {
  const taggedStablecoinBases = new Set<string>();
  const fiatQuoteAssets = new Set<string>();
  const tradingSymbols = new Set<string>();
  for (const r of rows) {
    if (r.st !== 'TRADING') continue;
    tradingSymbols.add(r.s);
    // Case-folded because the tag vocabulary is undocumented and already mixes conventions inside one payload (`stablecoin` and `pos` alongside `Payments` and `RWA`), so an exact match would turn a capitalisation change upstream into a silent loss of the entire veto.
    if (r.tags.some((tag) => tag.toLowerCase() === STABLECOIN_TAG)) taggedStablecoinBases.add(r.b);
    // The quote, never the base: `ADAEUR` is a FIAT row whose base is ordinary ADA.
    if (r.pm === FIAT_MARKET && r.pn === FIAT_MARKET) fiatQuoteAssets.add(r.q);
  }
  return {
    stablecoinOrFiatBases: new Set([...taggedStablecoinBases, ...fiatQuoteAssets]),
    taggedStablecoinBases,
    fiatQuoteAssets,
    tradingSymbols,
  };
};

/**
 * Refuse a classification that cannot be trusted to veto anything, by cross-checking it against live exchangeInfo in BOTH directions.
 *
 * The failure this guards is silent and total: a renamed key, a partial outage, or an empty response all degrade to "no asset is a stablecoin", which reads exactly like a healthy policy while admitting every one of them. One direction is not enough — a feed returning a stale subset still classifies correctly for the rows it does return, and only the missing live symbols expose it.
 *
 * The live universe is the reference even for a test-mode wake. Testnet lists a small, arbitrary subset and would pass a check against itself while the live feed was gutted; and testnet-only pairs have no product row at all, so they cannot be required to have one. Live pairs that are not `TRADING` are skipped for the same reason — the feed publishes trading products only.
 *
 * Throws rather than returning a verdict: every caller's only correct response is to abandon the cycle, and a boolean invites one of them to log it and continue.
 *
 * @param policy - The classification just derived from the feed.
 * @param liveAdmission - Symbol to exchangeInfo facts for the LIVE environment, the independent record of what is actually trading.
 * @returns Nothing; it throws on any condition that makes the policy unsafe to act on.
 */
export const validateAssetPolicy = (
  policy: AssetPolicy,
  liveAdmission: ReadonlyMap<string, SymbolAdmission>,
): void => {
  if (policy.tradingSymbols.size === 0) {
    throw new Error('discovery asset-policy: no product rows survived projection (schema drift?)');
  }
  // Per route, never on the merged set: the two routes are independent, and the fiat route alone always yields a dozen national currencies. A merged floor is therefore satisfied while the stablecoin route is dead, which admits every peg under a policy that still reads healthy.
  if (policy.taggedStablecoinBases.size === 0) {
    throw new Error(
      'discovery asset-policy: the stablecoin tag route classified nothing (tag renamed?)',
    );
  }
  if (policy.fiatQuoteAssets.size === 0) {
    throw new Error('discovery asset-policy: the fiat parent-market route classified nothing');
  }
  const liveTrading = new Set<string>();
  for (const [symbol, a] of liveAdmission) {
    if (a.status === 'TRADING') liveTrading.add(symbol);
  }
  if (liveTrading.size === 0) {
    throw new Error(
      'discovery asset-policy: empty symbol-admission map; cannot verify the classification is complete',
    );
  }
  for (const symbol of liveTrading) {
    if (!policy.tradingSymbols.has(symbol)) {
      throw new Error(
        `discovery asset-policy: product/exchangeInfo mismatch; ${symbol} is trading but has no product row`,
      );
    }
  }
  for (const symbol of policy.tradingSymbols) {
    // Symbols the bot cannot represent are skipped, not treated as drift. The admission map is not exchangeInfo itself: the refresh cron drops every ticker failing the same upper-case-alphanumeric character class, and Binance does list CJK-tickered pairs, so demanding they appear here would abort every cycle forever over a pair discovery could never bind anyway. `SymbolName` additionally bounds length, which is the stricter test and the right one for "a symbol this bot can represent"; no listed spot pair is near either bound.
    if (!SymbolName.safeParse(symbol).success) continue;
    if (!liveTrading.has(symbol)) {
      throw new Error(
        `discovery asset-policy: product/exchangeInfo mismatch; ${symbol} has a product row but is not trading`,
      );
    }
  }
};

/** Everything {@link createAssetPolicyResolver} needs from the world, injected so the snapshot logic is testable without a network or a wall clock. */
export interface AssetPolicyResolverDeps {
  /** Defaults to the global `fetch`; injected in tests and never pointed at a second host in production. */
  readonly fetchImpl?: typeof fetch;
  readonly clock: { nowMs(): number };
  readonly logger: Pick<Logger, 'info'>;
}

/**
 * Fetch the product feed once, projecting and deriving the classification.
 *
 * @param fetchImpl - The `fetch` implementation to call.
 * @returns The classification derived from this response; unvalidated, since completeness is checked per cycle against the mode-correct admission map.
 */
const fetchAssetPolicy = async (fetchImpl: typeof fetch): Promise<AssetPolicy> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(PRODUCTS_URL, {
      headers: { accept: 'application/json' },
      // Unsigned and off the REST host, so a followed redirect would let an arbitrary origin decide which assets discovery may buy. Binance does not redirect here; if it starts, the cycle must abort rather than comply.
      redirect: 'error',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`discovery asset-policy: upstream ${res.status} ${res.statusText}`);
    }
    const declaredBytes = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_DECLARED_BODY_BYTES) {
      throw new Error(
        `discovery asset-policy: upstream body ${declaredBytes}B exceeds ${MAX_DECLARED_BODY_BYTES}B`,
      );
    }
    return deriveAssetPolicy(projectProducts(await res.json()));
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Build the per-process accessor for the asset classification, holding one snapshot for {@link SNAPSHOT_MAX_AGE_MS}.
 *
 * Lazy: a wake where no profile is due never calls it, and therefore never touches the network. That is load-bearing beyond politeness — the hermetic e2e stack answers no traffic to this host.
 *
 * A stale snapshot is refetched, and a failed refetch propagates. Serving the stale one instead would be the quiet failure mode this whole module exists to avoid: the operator would see discovery running normally while it acted on a classification of unknown age.
 *
 * @param deps - Injected fetch, clock, and logger.
 * @returns An accessor resolving to a classification no older than {@link SNAPSHOT_MAX_AGE_MS}, or rejecting.
 */
export const createAssetPolicyResolver = (
  deps: AssetPolicyResolverDeps,
): (() => Promise<AssetPolicy>) => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let snapshot: { policy: AssetPolicy; observedAtMs: number } | null = null;
  // The cron's profile loop is sequential, but the diagnosis queue worker shares this accessor and runs concurrently in the same process. Without a memo of the in-flight fetch the two refresh separately and can hold classifications built from different payloads, which is exactly what sharing one accessor is meant to prevent.
  let inFlight: Promise<AssetPolicy> | null = null;
  return async () => {
    if (snapshot !== null && deps.clock.nowMs() - snapshot.observedAtMs < SNAPSHOT_MAX_AGE_MS) {
      return snapshot.policy;
    }
    if (inFlight !== null) return inFlight;
    inFlight = refresh();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };

  async function refresh(): Promise<AssetPolicy> {
    const policy = await fetchAssetPolicy(fetchImpl);
    // Stamped AFTER the load resolves, so the age measured later is the age of the data in hand. Stamping before the await dates the snapshot from the request instead, which on a slow response is born already expired.
    snapshot = { policy, observedAtMs: deps.clock.nowMs() };
    deps.logger.info(
      {
        stablecoinOrFiatBases: policy.stablecoinOrFiatBases.size,
        tradingSymbols: policy.tradingSymbols.size,
      },
      'cron discovery: refreshed the Binance asset classification',
    );
    return policy;
  }
};
