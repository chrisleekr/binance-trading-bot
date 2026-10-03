// The refusals that happen BEFORE anything is dispatched, and the shape of the call when one is.
//
// Every assertion here is about a decision made without a database, and that is deliberate: scope, idempotency and argument validation all have to hold whether or not Postgres is reachable, and a suite that needed infrastructure to check them would not run on a laptop.

import { repo } from '@app/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DI } from '../../src/di.js';
import {
  dispatchMcpTool,
  ORDER_PLACING_TOOLS,
  type McpDispatchDeps,
} from '../../src/mcp/dispatch.js';
import { idempotencyKeyFor } from '../../src/mcp/idempotency.js';
import { MCP_SCOPE_READ, MCP_SCOPE_TRADE } from '../../src/mcp/scopes.js';
import { MCP_TOOLS, MCP_TOOLS_BY_NAME } from '../../src/mcp/tools.js';
import type { UserId } from '@app/contracts';

/**
 * The inner router set, replaced so this file can decide what the dispatch does without a database.
 *
 * Mocked at the module rather than stubbed through `deps`, because `dispatchMcpTool` builds the app itself: the settlement cases below are about what happens when that build or that call goes wrong, and there is no other seam that can make it.
 */
vi.mock('../../src/mcp/inner-app.js', () => ({
  createMcpInnerApp: () => ({ fetch: (req: Request) => innerFetch(req) }),
}));

/** What the mocked inner app answers when a case does not set its own, which the read-tool scope case below genuinely reaches. */
const DEFAULT_INNER = async (): Promise<Response> => new Response('{}', { status: 200 });

/** Reassigned by the settlement cases and reset between them. Without the reset the file is correct only while those cases happen to run last, and a responder would silently leak into whatever ran next. */
let innerFetch: (req: Request) => Promise<Response> = DEFAULT_INNER;

beforeEach(() => {
  innerFetch = DEFAULT_INNER;
});

const OPERATOR = '00000000-0000-4000-8000-00000000a001' as UserId;

/** An in-memory stand-in for the dedup record, with the `SET NX PX` semantics the real one relies on. Written here rather than mocked call-by-call so the collision path is exercised against something that actually behaves like the store. */
const fakeRedis = (seed: Record<string, string> = {}) => {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    set: vi.fn(async (key: string, value: string, _mode: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK' as const;
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => keys.filter((key) => store.delete(key)).length),
    pexpire: vi.fn(async (key: string, _ttl: number) => (store.has(key) ? 1 : 0)),
  };
};

/** The ambiguous-failure sentinel, spelled without a literal control character so this source stays a text file. */
const FAILED_AMBIGUOUS = `${String.fromCharCode(0)}failed-ambiguous`;

const depsWith = (
  scopes: readonly string[],
  redis: ReturnType<typeof fakeRedis>,
): McpDispatchDeps => ({
  operatorId: OPERATOR,
  grantedScopes: new Set(scopes),
  di: {
    redis: { raw: () => redis },
    queue: { add: vi.fn() },
    logger: { warn: vi.fn(), error: vi.fn() },
    db: {},
  } as unknown as DI,
});

describe('MCP tool dispatch refusals', () => {
  it('refuses a trade tool for a read-only token and dispatches nothing', async () => {
    const redis = fakeRedis();
    const inner = vi.fn(DEFAULT_INNER);
    innerFetch = inner;
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_READ], redis), 'place_manual_order', {
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
      idempotencyKey: 'key-1-abcdef',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('insufficient_scope');
    expect(result.text).toContain(MCP_SCOPE_TRADE);
    // Nothing was claimed, which proves the scope check ran ahead of the idempotency claim rather than beside it. A claim taken before the refusal would burn the caller's key on a call that never happened.
    expect(redis.set).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it('lets a read tool through the scope check on a read-only token', async () => {
    // The discriminating half: without it, a scope check that refused everything would pass the assertion above.
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_READ], fakeRedis()), 'get_dashboard', {
      accountId: 'a',
      profileId: 'p',
    });
    expect(result.text).not.toContain('insufficient_scope');
  });

  it('refuses an order-placing tool that carries no idempotency key', async () => {
    const redis = fakeRedis();
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', {
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('idempotencyKey');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('replays the first outcome for a repeated idempotency key instead of placing again', async () => {
    const key = idempotencyKeyFor(OPERATOR, 'trigger_buy', 'key-42-abcdef');
    const redis = fakeRedis({ [key]: '{"binanceMode":"test","result":{"ok":true}}' });
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', {
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
      idempotencyKey: 'key-42-abcdef',
    });
    expect(result.isError).toBe(false);
    expect(result.text).toBe('{"binanceMode":"test","result":{"ok":true}}');
  });

  it('refuses rather than places when the key is claimed but has no recorded outcome yet', async () => {
    // The in-flight case. Answering "success" here would tell the agent an order it cannot see is done; answering by placing a second one is the double-spend the record exists to stop. Refusing is the only answer that is neither.
    const key = idempotencyKeyFor(OPERATOR, 'trigger_sell', 'key-99-abcdef');
    const redis = fakeRedis({ [key]: '\u0000in-flight' });
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_sell', {
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
      idempotencyKey: 'key-99-abcdef',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/still running/);
    // The remedy has to be the one that fits this state. A call genuinely still in flight is the one case where waiting is right and where sending the agent off to reconcile order state would be premature, so the sentence reserved for the ambiguous-failure state must not appear here.
    expect(result.text).not.toMatch(/list_orders/);
  });

  it('tells a retry to reconcile, not to wait, when the earlier call failed after it may have armed an order', async () => {
    // The state the in-flight sentinel used to be overloaded with. Nothing is running, so "wait for it" would be advice to wait forever; the only useful instruction is to go and look at the order state.
    const key = idempotencyKeyFor(OPERATOR, 'trigger_sell', 'key-amb-abcdef');
    const redis = fakeRedis({ [key]: '\u0000failed-ambiguous' });
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_sell', {
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
      idempotencyKey: 'key-amb-abcdef',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/may still have placed an order/);
    expect(result.text).toMatch(/list_orders/);
    expect(result.text).not.toMatch(/still running/);
  });

  it('refuses and says so when the record aged out while the earlier call was still open', async () => {
    // `SET NX` loses and the follow-up GET finds nothing, which means the window expired mid-flight. Dispatching would be the double-spend the record exists to prevent, at the one moment there is no evidence either way, so the refusal names the uncertainty instead of inventing an outcome.
    const key = idempotencyKeyFor(OPERATOR, 'trigger_buy', 'key-gone-abcdef');
    const redis = fakeRedis();
    // Loses the NX claim, then reports the key absent: the interleaving the real store produces when the TTL lapses between the two commands.
    redis.set.mockResolvedValueOnce(null);
    redis.get.mockResolvedValueOnce(null);
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', {
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
      idempotencyKey: 'key-gone-abcdef',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no longer known/);
    expect(redis.store.has(key)).toBe(false);
  });

  it('refuses an unknown tool name', async () => {
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], fakeRedis()), 'rm_rf', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('unknown tool');
  });

  it('does not spend the idempotency key on a call its own arguments refuse', async () => {
    // `plan` is the last thing that can refuse on arguments alone, and it refuses a path parameter that cannot be one segment. Claimed first, the key would be held for the whole window over a call that never reached a route, and the caller most likely to present it again is the one whose argument was just rejected.
    const redis = fakeRedis();
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', {
      accountId: 'a',
      profileId: 'p',
      symbol: '../../backup',
      idempotencyKey: 'key-unspent-abcdef',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/single path segment/);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.store.size).toBe(0);
  });

  it('refuses arguments that fail the tool schema', async () => {
    const result = await dispatchMcpTool(
      depsWith([MCP_SCOPE_TRADE], fakeRedis()),
      'disable_symbol',
      { accountId: 'a', profileId: 'p', symbol: 'BTCUSDT', ttlSeconds: 999_999_999 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain('ttlSeconds');
  });
});

describe('MCP request plans', () => {
  it('fills path parameters and leaves reserved arguments out of the body', () => {
    const tool = MCP_TOOLS_BY_NAME.get('place_manual_order');
    expect(tool).toBeDefined();
    const plan = tool?.plan({
      accountId: 'acc-1',
      profileId: 'prof-1',
      symbol: 'BTCUSDT',
      idempotencyKey: 'key-1-abcdef',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
    });
    expect(plan?.path).toBe('/api/accounts/acc-1/profiles/prof-1/symbols/BTCUSDT/manual-order');
    // The key is the dedup layer's input, not the route's. Forwarding it would make every order body carry a field the route's schema rejects.
    expect(plan?.body).toEqual({ side: 'BUY', type: 'MARKET', quantity: '1' });
  });

  it('routes a consolidated read by its kind selector', () => {
    const tool = MCP_TOOLS_BY_NAME.get('get_market_data');
    const depth = tool?.plan({
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
      kind: 'depth',
      limit: 50,
    });
    const candles = tool?.plan({
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
      kind: 'candles',
      interval: '1h',
    });
    expect(depth?.path.endsWith('/depth')).toBe(true);
    expect(candles?.path.endsWith('/candles')).toBe(true);
    // A read carries its remaining arguments as query, never as a body: the routes are GETs.
    expect(depth?.query).toEqual({ limit: '50' });
    expect(depth?.body).toBeNull();
  });

  it('refuses a path parameter that is not one segment, rather than encoding it', () => {
    // Encoding alone was the weaker property. `encodeURIComponent` leaves a dot alone, and the URL parser removes dot-segments before Hono sees the path, so `..` shortens the route to a different one: for `remove_symbol` that is the shape of profile delete, which the tool table denies outright. The refusal holds whatever the router's trailing-slash behaviour is, which is the only thing standing in the way today.
    const tool = MCP_TOOLS_BY_NAME.get('get_profile');
    expect(() => tool?.plan({ accountId: 'a', profileId: '../../backup' })).toThrow(
      /single path segment/,
    );
  });

  it('still plans an ordinary path parameter through unchanged', () => {
    // The discriminating half: a refusal that rejected everything would satisfy the case above.
    const tool = MCP_TOOLS_BY_NAME.get('get_profile');
    expect(tool?.plan({ accountId: 'acc-1', profileId: 'prof-1' }).path).toBe(
      '/api/accounts/acc-1/profiles/prof-1',
    );
  });
});

/** The route suffixes that reach Binance's order book. Read off the tool table's own signatures below rather than compared against a retyped tool list, so a tool added at one of these endpoints is caught by the set it forgot to join. */
const ORDER_PLACING_ROUTES =
  /\/(manual-order|manual-order-all|trigger-buy|trigger-sell|force-eject)$/;

describe('order-placing tools require an idempotency key by schema', () => {
  it('enumerates a non-empty set, so the sweep below is not vacuous', () => {
    expect(ORDER_PLACING_TOOLS.size).toBeGreaterThan(0);
  });

  it('equals the set of tools whose routes reach the order book', () => {
    // A size floor catches an emptied collection and nothing else: a sixth order-placing tool added to the table and not to this set leaves the count higher than zero and every case below still green. Set-equality against a second, independent reading of the table is what makes the omission fail.
    const byRoute = MCP_TOOLS.filter((tool) =>
      tool.routes.some((route) => ORDER_PLACING_ROUTES.test(route)),
    ).map((tool) => tool.name);
    expect(byRoute.length).toBeGreaterThan(0);
    expect([...ORDER_PLACING_TOOLS].sort()).toEqual([...byRoute].sort());
  });

  it('marks no read tool as order-placing', () => {
    // The flag decides whether a retry can place a second real order, so a read carrying it would demand an idempotency key for a question, and a write missing it is the failure this whole group is about.
    for (const tool of MCP_TOOLS) {
      if (tool.placesOrder) expect(tool.scope).toBe(MCP_SCOPE_TRADE);
    }
  });

  it.each([...ORDER_PLACING_TOOLS])('%s rejects arguments with no idempotencyKey', (name) => {
    // This is the live enforcement. The runtime check inside `dispatchMcpTool` cannot fire while these schemas stay as they are, so pinning it there would pin nothing; relax one of them to `.optional()` and the dedup key becomes the literal string "undefined", shared by every caller of that tool.
    const tool = MCP_TOOLS_BY_NAME.get(name);
    expect(tool).toBeDefined();
    const parsed = tool?.inputSchema.safeParse({
      accountId: 'a',
      profileId: 'p',
      symbol: 'BTCUSDT',
      quote: 'USDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
    });
    expect(parsed?.success).toBe(false);
    expect(JSON.stringify(parsed)).toContain('idempotencyKey');
  });

  it('every order-placing tool named here exists in the table', () => {
    // A name in the set that names no tool would make its case above pass on an undefined lookup.
    for (const name of ORDER_PLACING_TOOLS) expect(MCP_TOOLS_BY_NAME.get(name)).toBeDefined();
  });
});

/**
 * What the dedup record is left holding when the dispatch itself goes wrong.
 *
 * The claim is written before anything is dispatched, so every path out of the dispatch has to decide what the record now says. The expensive inversion is a storage fault outranking the real outcome: an agent told its order failed retries it, and the retry is a second real order. These cases pin that the outcome wins and the record is only ever a retry aid.
 */
describe('settling the dedup record when the dispatch itself fails', () => {
  const ARGS = {
    accountId: 'a',
    profileId: 'p',
    symbol: 'BTCUSDT',
    idempotencyKey: 'key-settle-abcdef',
  };
  const KEY = idempotencyKeyFor(OPERATOR, 'trigger_buy', ARGS.idempotencyKey);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('holds the key as ambiguous when the dispatch throws before it can report an outcome', async () => {
    // A throw carries no status, so the status rule has nothing to read. The override row reaches Redis before the tick is enqueued, so a failure anywhere in the dispatch can still leave a live override a later tick executes: releasing the key here would invite a retry that becomes a second real order.
    innerFetch = () => Promise.reject(new Error('inner app exploded'));
    const redis = fakeRedis();
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', ARGS);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/may still have placed an order/);
    expect(result.text).toMatch(/list_orders/);
    // The record, not just the sentence: left on the in-flight sentinel it would tell the next retry to wait for a call that already stopped.
    expect(redis.store.get(KEY)).toBe('\u0000failed-ambiguous');
  });

  it('returns the placed order even when recording its outcome fails', async () => {
    // The inversion that costs money. A Redis fault after a 2xx must not turn a placed order into a reported failure, because the agent's correct response to a reported failure is to retry it.
    innerFetch = async () => new Response('{"scheduled":true}', { status: 200 });
    const redis = fakeRedis();
    // Only the outcome write fails. The claim and its fingerprint have to land first, or the call never reaches the route whose success this case is about.
    redis.set.mockImplementation(async (k, _v, _m, _t, nx?: string) => {
      if (nx === 'NX' || k === `${KEY}:fp`) return 'OK' as const;
      throw new Error('redis down');
    });
    vi.spyOn(repo.accounts, 'binanceModeById').mockResolvedValue('test');
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', ARGS);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ result: { scheduled: true } });
  });

  it("surfaces the route's own refusal even when freeing the key fails", async () => {
    // The caller needs the reason the route gave. A storage error substituted here would send the agent to fix the wrong thing.
    innerFetch = async () =>
      new Response('{"error":{"code":"VALIDATION_FAILED"}}', { status: 422 });
    const redis = fakeRedis();
    redis.del.mockRejectedValue(new Error('redis down'));
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', ARGS);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 422 from trigger_buy');
    expect(result.text).toContain('VALIDATION_FAILED');
  });

  it('frees the key when the route refuses with a 4xx, so the corrected retry can claim it', async () => {
    // A 4xx is a guard declining ahead of every write. Left on the in-flight sentinel, the key would refuse the corrected retry for the whole window over a call that armed nothing.
    innerFetch = async () => new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 });
    const redis = fakeRedis();
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', ARGS);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 404 from trigger_buy');
    expect(redis.store.has(KEY)).toBe(false);
    expect(redis.store.has(`${KEY}:fp`)).toBe(false);
  });

  it('holds the key as ambiguous when the route fails with a 5xx', async () => {
    // A 5xx is reached through an enqueue whose rollback may not have taken, so the override can still be live. Releasing here would turn the retry into a second real order, and leaving the in-flight sentinel would tell it to wait for a call that already stopped.
    innerFetch = async () => new Response('{"error":{"code":"UNAVAILABLE"}}', { status: 503 });
    const redis = fakeRedis();
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'trigger_buy', ARGS);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 503 from trigger_buy');
    expect(redis.store.get(KEY)).toBe(FAILED_AMBIGUOUS);
  });

  it('reports an unreadable account as unknown rather than omitting the mode', async () => {
    // An absent row answers null rather than throwing, and an omitted field reads as "operator-global", which an account-scoped tool never is.
    innerFetch = async () => new Response('{"ok":true}', { status: 200 });
    vi.spyOn(repo.accounts, 'binanceModeById').mockResolvedValue(null);
    const result = await dispatchMcpTool(
      depsWith([MCP_SCOPE_TRADE], fakeRedis()),
      'trigger_buy',
      ARGS,
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ binanceMode: 'unknown' });
  });
});

/**
 * A key names one request. Presented again with the same arguments it replays; presented with different arguments it must be refused, because replaying the first answer would report an order the caller did not ask for as placed and silently drop the one it did.
 */
describe('reusing an idempotency key', () => {
  const BUY = {
    accountId: 'a',
    profileId: 'p',
    symbol: 'BTCUSDT',
    idempotencyKey: 'key-reuse-abcdef',
    side: 'BUY',
    type: 'MARKET',
    quantity: '1',
  };
  const KEY = idempotencyKeyFor(OPERATOR, 'place_manual_order', BUY.idempotencyKey);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Places the first order through the real dispatch path, so the record and its fingerprint are whatever production writes rather than a hand-seeded guess. */
  const placeFirst = async (redis: ReturnType<typeof fakeRedis>) => {
    const inner = vi.fn(async () => new Response('{"orderId":1}', { status: 200 }));
    innerFetch = inner;
    vi.spyOn(repo.accounts, 'binanceModeById').mockResolvedValue('test');
    const first = await dispatchMcpTool(
      depsWith([MCP_SCOPE_TRADE], redis),
      'place_manual_order',
      BUY,
    );
    expect(first.isError).toBe(false);
    expect(inner).toHaveBeenCalledTimes(1);
    return { first, inner };
  };

  it('replays the first outcome when the same key arrives with the same arguments', async () => {
    const redis = fakeRedis();
    const { first, inner } = await placeFirst(redis);
    // Same request, keys in a different order: an ordinary retry, which must replay rather than be refused as a different request.
    const { quantity, type, side, ...rest } = BUY;
    const retry = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'place_manual_order', {
      quantity,
      type,
      side,
      ...rest,
    });
    expect(retry).toEqual({ isError: false, text: first.text });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('refuses, dispatches nothing and keeps the first record when the same key arrives with a different side', async () => {
    const redis = fakeRedis();
    const { first, inner } = await placeFirst(redis);
    const result = await dispatchMcpTool(depsWith([MCP_SCOPE_TRADE], redis), 'place_manual_order', {
      ...BUY,
      side: 'SELL',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/different request/);
    expect(result.text).toMatch(/new idempotencyKey/);
    expect(result.text).not.toContain(first.text);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(redis.store.get(KEY)).toBe(first.text);
  });
});
