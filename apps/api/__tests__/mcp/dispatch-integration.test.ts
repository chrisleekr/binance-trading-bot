// Dispatch against the REAL routers, the real database and the real audit table.
//
// Everything else in this directory checks decisions taken before a request is made. This file checks the one claim none of those can: that a tool call goes through the same `mountApiRouters` set the browser uses, carries the same ownership proof, and leaves the same kind of row behind — with `actor='agent'` as the only difference.

import { AgentActionNotifyJob } from '@app/contracts';
import { dashboardAggregateCacheKey, GLOBAL_KEYS, profileKey } from '@app/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatchMcpTool, type McpDispatchDeps } from '../../src/mcp/dispatch.js';
import {
  claimIdempotencyKey,
  idempotencyKeyFor,
  recordIdempotentOutcome,
  releaseIdempotencyKey,
  type IdempotencyRedis,
} from '../../src/mcp/idempotency.js';
import { MCP_SCOPE_READ, MCP_SCOPE_TRADE } from '../../src/mcp/scopes.js';
import { EXCHANGE_INFO_REDIS_KEY } from '../../src/routes/exchange-info.js';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

const depsFor = (fx: ApiFixture, scopes: readonly string[]): McpDispatchDeps => ({
  di: { ...fx.di, queue: { add: vi.fn() } as never },
  operatorId: fx.alice.userId,
  grantedScopes: new Set(scopes),
});

/** Same, but the queue records what it was handed, so the enqueued payload can be examined instead of only counted. */
const capturingDeps = (
  fx: ApiFixture,
  calls: { name: string; data: unknown }[],
): McpDispatchDeps => ({
  di: {
    ...fx.di,
    queue: { add: async (name: string, data: unknown) => void calls.push({ name, data }) } as never,
  },
  operatorId: fx.alice.userId,
  grantedScopes: new Set([MCP_SCOPE_TRADE]),
});

describe.skipIf(!HAS_INFRA)('MCP dispatch through the real routers', () => {
  // One fixture for the file. Provisioning it inside each `it` put a container cold start under the 5s test timeout, where the first case times out and every later one passes on the warm fixture — a failure that reads as a defect in the code under test rather than in the harness.
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    // Bind the symbol the order-arming cases act on. Those cases are about dedup and attribution, so the request has to be one the route would otherwise accept: an unbound symbol is refused earlier and for an unrelated reason, and they would then be asserting a replay they never reached.
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source, pinned)
       values ($1, 'ETHUSDT', 'ETH', 'manual', true)
       on conflict do nothing`,
      [fx.alice.profileId],
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('reads a profile through the shared router set', async () => {
    {
      const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'get_profile', {
        accountId: fx.alice.accountId,
        profileId: fx.alice.profileId,
      });
      expect(result.isError).toBe(false);
      const payload = JSON.parse(result.text) as { binanceMode?: string; result?: unknown };
      // Testnet and live accounts share every table and every tool, so the mode is echoed on each account-scoped result: without it a wrong-accountId call is indistinguishable from a right one in the transcript.
      expect(payload.binanceMode).toBe('test');
      expect(payload.result).toMatchObject({ id: fx.alice.profileId });
    }
  });

  it('surfaces a route error as a tool error rather than a success', async () => {
    {
      const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'get_profile', {
        accountId: fx.alice.accountId,
        profileId: '00000000-0000-4000-8000-0000000000ff',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('HTTP 404');
    }
  });

  it('returns only the pairs get_exchange_info names, not the whole listing', async () => {
    // Binance lists thousands of pairs and each carries its filter set and permission tags, so the unnarrowed body runs to megabytes: calling this tool without a narrowing spends an agent's entire context on permission tags before it can size one order. The narrowing is asserted end to end because it has two halves that can each be right alone, the tool putting the pairs on the query string and the route reading them back off it.
    await fx.di.redis.raw().set(
      EXCHANGE_INFO_REDIS_KEY,
      JSON.stringify({
        fetchedAt: '2026-09-13T00:00:00.000Z',
        symbols: [
          { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
          { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
          { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT', status: 'TRADING' },
        ],
      }),
    );

    const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'get_exchange_info', {
      symbols: ['BTCUSDT', 'XRPUSDT'],
    });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.text) as { result: { symbols: { symbol: string }[] } };
    expect(payload.result.symbols.map((entry) => entry.symbol)).toEqual(['BTCUSDT', 'XRPUSDT']);
  });

  it('refuses a get_exchange_info call that names no pair', async () => {
    // The argument is required rather than optional-with-a-default, so the refusal happens at the tool schema and the megabyte body is unreachable rather than merely discouraged.
    const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'get_exchange_info', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('symbols');
  });

  it('carries get_market_data limit down to the exchange call, and defaults it when unasked', async () => {
    // The tool declared `limit` while none of the four routes read one, so an agent asking for five order-book levels was served a hundred and had no way to know. The assertion is on what the Binance client was handed, because that is the only place the difference between "asked for five" and "served a hundred" exists.
    const seen: { depth: number[]; trades: number[] } = { depth: [], trades: [] };
    const di = fx.di as unknown as {
      marketData: {
        getDepth: (mode: string, symbol: string, limit: number) => Promise<unknown>;
        getRecentTrades: (mode: string, symbol: string, limit: number) => Promise<unknown>;
      };
    };
    const restore = { ...di.marketData };
    di.marketData.getDepth = async (_mode, _symbol, limit) => {
      seen.depth.push(limit);
      return { bids: [['1', '2']], asks: [['3', '4']] };
    };
    di.marketData.getRecentTrades = async (_mode, _symbol, limit) => {
      seen.trades.push(limit);
      return [];
    };
    try {
      const base = {
        accountId: fx.alice.accountId,
        profileId: fx.alice.profileId,
        symbol: 'ETHUSDT',
      };
      const withLimit = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'get_market_data', {
        ...base,
        kind: 'depth',
        limit: 5,
      });
      expect(withLimit.isError).toBe(false);
      // Omitted rather than passed as zero: the route's own ceiling is what an unasked call gets, so the panel's ladder is unchanged by this parameter existing.
      const withoutLimit = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'get_market_data', {
        ...base,
        kind: 'depth',
      });
      expect(withoutLimit.isError).toBe(false);
      const trades = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'get_market_data', {
        ...base,
        kind: 'trades',
        limit: 3,
      });
      expect(trades.isError).toBe(false);
      expect(seen.depth).toEqual([5, 100]);
      expect(seen.trades).toEqual([3]);
    } finally {
      Object.assign(di.marketData, restore);
    }
  });

  it('refuses to reach another operator account, through the same scope proof the browser hits', async () => {
    {
      const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'get_profile', {
        accountId: fx.bob.accountId,
        profileId: fx.bob.profileId,
      });
      // Not a special MCP check: `scopeProfile` proves the ownership chain in one query for every caller, and the agent path gets it because it dispatches into the same routers rather than re-implementing them.
      expect(result.isError).toBe(true);
    }
  });

  it("writes the audit row with actor='agent'", async () => {
    {
      // A route that declares an audit event, since this assertion is about the actor the middleware stamps rather than about which routes declare one. The enumerating guard beside this file answers the second question for the whole tool table.
      const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_TRADE]), 'stop_profile', {
        accountId: fx.alice.accountId,
        profileId: fx.alice.profileId,
      });
      expect(result.isError).toBe(false);
      const rows = await fx.di.pool.query<{ actor: string; event: string }>(
        `select actor, event from audit_logs where operator_id = $1 order by created_at desc limit 5`,
        [fx.alice.userId],
      );
      expect(rows.rows[0]).toMatchObject({ actor: 'agent', event: 'stop-profile' });
    }
  });

  it("records a profile config edit under actor='agent'", async () => {
    // `update_profile` is the tool that rewrites a whole strategy configuration, and its route declared no audit event until this change. The static guard proves the declaration is there; only a real dispatch proves the row lands, with the agent attribution that makes the edit traceable to something other than the operator.
    const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_TRADE]), 'update_profile', {
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
      name: 'renamed-by-agent',
    });
    expect(result.isError).toBe(false);
    const rows = await fx.di.pool.query<{ actor: string; event: string; payload: unknown }>(
      `select actor, event, payload from audit_logs where operator_id = $1 order by created_at desc limit 1`,
      [fx.alice.userId],
    );
    expect(rows.rows[0]).toMatchObject({ actor: 'agent', event: 'update-profile' });
    expect(rows.rows[0]?.payload).toMatchObject({ fields: ['name'] });
  });

  it("names the calling agent's address and client in the audit row", async () => {
    // The inner request is built by this process, so it carries no headers unless they are forwarded deliberately. Without that the audit row records the address as the literal `unknown` and the client as null on the one surface reachable from anywhere, which is the weakest trail in the system sitting where it is least affordable. The forwarding header is passed through unparsed so `clientIp` stays the only place an address is derived: the value asserted here is the RIGHTMOST hop, because the leftmost entries are client-controlled and forgeable.
    const result = await dispatchMcpTool(
      {
        ...depsFor(fx, [MCP_SCOPE_TRADE]),
        clientContext: {
          forwardedFor: '9.9.9.9, 203.0.113.7',
          realIp: null,
          userAgent: 'claude-code/2.1.269',
        },
      },
      'stop_profile',
      { accountId: fx.alice.accountId, profileId: fx.alice.profileId },
    );
    expect(result.isError).toBe(false);
    const rows = await fx.di.pool.query<{ ip: string; user_agent: string; actor: string }>(
      `select ip, user_agent, actor from audit_logs where operator_id = $1 order by created_at desc limit 1`,
      [fx.alice.userId],
    );
    expect(rows.rows[0]).toMatchObject({
      actor: 'agent',
      ip: '203.0.113.7',
      user_agent: 'claude-code/2.1.269',
    });
  });

  it('frees the idempotency key when the route refused before arming anything', async () => {
    // The lockout this fixes: a key is claimed before dispatch, so a call refused for a bad argument used to leave the record on its in-flight sentinel for the full window. The agent would correct the argument, retry with the same key, and be told its call was "already running" when nothing was running and nothing had been placed.
    const redis = fx.di.redis.raw() as unknown as { get(k: string): Promise<string | null> };
    const key = idempotencyKeyFor(fx.alice.userId, 'trigger_buy', 'settle-release-key');
    const refused = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_TRADE]), 'trigger_buy', {
      accountId: fx.alice.accountId,
      // Owned by nobody, so `scopeOf` refuses ahead of the override row and the tick.
      profileId: '00000000-0000-4000-8000-0000000000ff',
      symbol: 'BTCUSDT',
      idempotencyKey: 'settle-release-key',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('404');
    expect(await redis.get(key)).toBeNull();
  });

  it('accepts the bulk fan-out arguments the tool declares, rather than 400ing on its own schema', async () => {
    // The bulk tool declared `side` in uppercase while the route's contract spells it lowercase, and the dispatcher copies arguments into the body verbatim. Every invocation 400d, so the most dangerous tool in the table could never fire, and nothing noticed because no test at any layer called it. Two spellings of one value, with no gate comparing them.
    //
    // Asserting "not a schema rejection" rather than a placed order. The quote matches no bound symbol, so the fan-out schedules nothing, which is what makes a bulk market sell safe to run here. It still fails if the shapes disagree, because the body parse rejects before any matching happens.
    const result = await dispatchMcpTool(
      depsFor(fx, [MCP_SCOPE_TRADE]),
      'place_market_order_all_symbols',
      {
        accountId: fx.alice.accountId,
        profileId: fx.alice.profileId,
        idempotencyKey: `bulk-shape-${Date.now()}`,
        quote: 'ZZZ',
        side: 'sell',
        quoteAmount: '10',
      },
    );
    expect(result.text).not.toContain('HTTP 400');
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.text) as {
      result?: { scheduled?: number; failedSymbols?: string[] };
    };
    expect(payload.result?.scheduled).toBe(0);
    // Named rather than merely counted, so a caller can tell which positions a partial fan-out left open.
    expect(payload.result?.failedSymbols).toEqual([]);
  });

  it('leaves a server-side trace when an agent order is refused', async () => {
    // The audit middleware skips a 4xx by design and no notification is raised for a refusal, so without this log line the only record that an agent tried to trade and was turned away lives in the agent's own transcript. On a publicly reachable endpoint that is the difference between a blind spot and an observable one.
    const warnings: { msg: string; fields: Record<string, unknown> }[] = [];
    const deps: McpDispatchDeps = {
      ...depsFor(fx, [MCP_SCOPE_TRADE]),
      di: {
        ...fx.di,
        queue: { add: vi.fn() },
        logger: {
          ...fx.di.logger,
          warn: (fields: Record<string, unknown>, msg: string) => warnings.push({ msg, fields }),
        },
      } as never,
    };
    const refused = await dispatchMcpTool(deps, 'trigger_sell', {
      accountId: fx.alice.accountId,
      profileId: '00000000-0000-4000-8000-0000000000ff',
      symbol: 'BTCUSDT',
      idempotencyKey: `refusal-trace-${Date.now()}`,
    });
    expect(refused.isError).toBe(true);
    const refusal = warnings.find((w) => w.msg === 'mcp_tool_refused');
    expect(refusal).toBeDefined();
    expect(refusal?.fields).toMatchObject({ tool: 'trigger_sell', status: 404 });
  });

  it("leaves actor='user' on the cookie-authenticated path", async () => {
    {
      const res = await fx.app.request(
        `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/stop`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-test-user-id': fx.alice.userId },
        },
      );
      expect(res.status).toBeLessThan(400);
      const rows = await fx.di.pool.query<{ actor: string }>(
        `select actor from audit_logs where operator_id = $1 order by created_at desc limit 1`,
        [fx.alice.userId],
      );
      expect(rows.rows[0]?.actor).toBe('user');
    }
  });

  it('completes the action even when the notification cannot be enqueued', async () => {
    // The notification is raised after the action has already happened, so a Redis or queue fault must not turn a completed stop into a reported failure. Muting works the same way one layer down: the worker answers a disabled category with `muted`, and nothing about the action changes.
    const deps: McpDispatchDeps = {
      di: {
        ...fx.di,
        queue: {
          add: async () => {
            throw new Error('queue unavailable');
          },
        } as never,
      },
      operatorId: fx.alice.userId,
      grantedScopes: new Set([MCP_SCOPE_TRADE]),
    };
    // `disable_all_symbols` rather than `stop_profile`: this file shares one fixture, a profile already stopped by an earlier case refuses a second stop, and the refusal would be mistaken for the notification failure this is about.
    const result = await dispatchMcpTool(deps, 'disable_all_symbols', {
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
    });
    expect(result.isError).toBe(false);
  });

  it('drops the dashboard read-through caches after an agent write', async () => {
    // The inner app is a separate Hono instance, so none of the public app's middleware runs for a tool call and the cache-bust had to be mounted there a second time. Without it an agent that disables symbols is served the pre-change dashboard for the rest of the 15s TTL, reads its own write as never having happened, and reissues it. The caches are shared, so the operator's own SPA replays the same stale blob.
    const redis = fx.di.redis.raw();
    const dashboardKey = profileKey(
      { accountId: fx.alice.accountId, profileId: fx.alice.profileId },
      'dashboardCache',
    );
    const aggregateKey = dashboardAggregateCacheKey(fx.alice.accountId);
    await redis.set(dashboardKey, JSON.stringify({ stale: true }));
    await redis.set(aggregateKey, JSON.stringify({ stale: true }));
    const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_TRADE]), 'disable_all_symbols', {
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
    });
    expect(result.isError).toBe(false);
    // Both keys, because they are dropped by different arguments to one call: the account aggregate is always cleared and the per-profile blob only when the route carries `:profileId`, so asserting one leaves the other free to go stale.
    expect(await redis.get(dashboardKey)).toBeNull();
    expect(await redis.get(aggregateKey)).toBeNull();
  });

  it('rejects a schema-invalid strategy config and persists nothing', async () => {
    {
      const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_TRADE]), 'update_profile', {
        accountId: fx.alice.accountId,
        profileId: fx.alice.profileId,
        config: { thisFieldDoesNotExist: 'nope' },
      });
      expect(result.isError).toBe(true);
    }
  });

  it('enqueues a notification the worker will accept, field for field', async () => {
    // The one seam neither package can see across. The api builds this payload and the worker parses it, and a field renamed on either side is invisible to both type systems, so the job dead-letters and every agent action goes unannounced while both suites stay green.
    //
    // The payload is captured from a REAL dispatch rather than retyped, then run through the very schema the worker's `parseAgentActionNotifyJob` delegates to. A hand-written literal here would only prove the literal parses.
    const calls: { name: string; data: unknown }[] = [];
    const result = await dispatchMcpTool(capturingDeps(fx, calls), 'disable_all_symbols', {
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
    });
    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    // The job NAME is half the seam: the worker dispatches on it and an unhandled name hits `default:` and dead-letters.
    expect(calls[0]?.name).toBe('notify-agent-action');
    const parsed = AgentActionNotifyJob.safeParse(calls[0]?.data);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      accountId: fx.alice.accountId,
      tool: 'disable_all_symbols',
    });
  });

  it('dedups a repeated idempotency key against the real Redis', async () => {
    // Every other idempotency case runs against an in-memory stand-in written in this repo, which can get `SET key value PX ttl NX` wrong in exactly the direction the production code gets it wrong and still agree with itself. This is the only case that asks ioredis.
    const redis = fx.di.redis.raw() as unknown as IdempotencyRedis;
    const key = idempotencyKeyFor(fx.alice.userId, 'place_manual_order', `k-${Date.now()}`);
    const first = await claimIdempotencyKey(redis, key, 'fp-a');
    expect(first.status).toBe('claimed');
    // A second call while the first is still running: refused rather than allowed through, because a retry of an order-placing tool is a second real order.
    const second = await claimIdempotencyKey(redis, key, 'fp-a');
    expect(second).toEqual({ status: 'in-flight' });
    await recordIdempotentOutcome(redis, key, '{"result":"done"}');
    // Once the outcome is recorded the retry gets the first answer back rather than a refusal, which is what makes a client retry safe rather than merely blocked.
    const third = await claimIdempotencyKey(redis, key, 'fp-a');
    expect(third).toEqual({ status: 'replay', recorded: '{"result":"done"}' });
    // The release path against the real client too, since a multi-key `DEL` and `PEXPIRE` are the settlement commands the in-memory stand-in could model differently from ioredis.
    await releaseIdempotencyKey(redis, key);
    expect(await redis.get(`${key}:fp`)).toBeNull();
    expect(await claimIdempotencyKey(redis, key, 'fp-b')).toEqual({ status: 'claimed' });
  });

  it('dedups a repeated idempotency key through dispatchMcpTool, not just the primitive', async () => {
    // The case above asks the Redis primitive directly, which proves `SET NX PX` behaves and nothing about whether the dispatcher uses it. A claim that was never wired, or wired after the request instead of before it, passes that test and places two real orders.
    const symbol = 'ETHUSDT';
    const args = {
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
      symbol,
      idempotencyKey: `wired-${Date.now()}`,
    };
    const first = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_TRADE]), 'trigger_buy', args);
    expect(first.isError).toBe(false);
    const replayed = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_TRADE]), 'trigger_buy', args);
    // Byte-identical to the first answer: the retry is given the recorded outcome rather than a refusal, which is what makes an agent's ordinary timeout-and-retry safe instead of merely blocked.
    expect(replayed.isError).toBe(false);
    expect(replayed.text).toBe(first.text);
    // The discriminating half. Two identical answers would also be produced by two real dispatches, so the row count is what says the second call never reached the route.
    const rows = await fx.di.pool.query<{ n: string }>(
      `select count(*)::text as n from override_actions where profile_id = $1 and symbol = $2`,
      [fx.alice.profileId, symbol],
    );
    expect(rows.rows[0]?.n).toBe('1');
  });

  it('previews the merged configuration without persisting it', async () => {
    const symbol = 'BTCUSDT';
    // The seeded profile stores `{}`, and an override is merged onto the STORED config before it is re-checked, so a candidate on top of an empty base is refused as incomplete. Giving the profile the strategy's own default first is what makes the merge the thing under test rather than the seed.
    // Strategy and version read off the profile row rather than named here, so the default this seeds with is the one that profile actually runs.
    const row = await fx.di.pool.query<{ strategy_name: string; strategy_version: string }>(
      `select strategy_name, strategy_version from profiles where id = $1`,
      [fx.alice.profileId],
    );
    const strategy = fx.di.strategies.describeForProfile(
      row.rows[0]?.strategy_name ?? '',
      row.rows[0]?.strategy_version ?? '',
    );
    expect(strategy.status).not.toBe('unknown');
    const seeded = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_TRADE]), 'update_profile', {
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
      config:
        strategy.status === 'unknown'
          ? {}
          : (strategy.strategy.defaultConfig as Record<string, unknown>),
    });
    expect(seeded.isError).toBe(false);
    // A projection with nothing to project from degrades to an empty section list, which an `Array.isArray` check cannot tell apart from a strategy that was never consulted. Trailing-trade returns early unless it has a cost basis, so both a feed price and an entry price are what make the levels themselves observable. `avg_entry_prices` keys on the profile alone, so seeding one does not bind the symbol and leaves the persistence half of this test measuring what it says it measures.
    await fx.di.redis.raw().set(GLOBAL_KEYS.ticker(symbol), JSON.stringify({ price: '50000.00' }));
    await fx.di.pool.query(
      `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity) values ($1, $2, $3, $4) on conflict (profile_id, symbol) do update set avg_entry_price = excluded.avg_entry_price`,
      [fx.alice.profileId, symbol, '48000', '0.1'],
    );
    const before = await fx.di.pool.query<{ n: string }>(
      `select count(*)::text as n from profile_symbols where profile_id = $1`,
      [fx.alice.profileId],
    );
    const result = await dispatchMcpTool(depsFor(fx, [MCP_SCOPE_READ]), 'preview_config', {
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
      symbol,
      config: { sell: { triggerPercentage: '1.20' } },
    });
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.text) as {
      result?: {
        sections?: { title?: string; rows?: { label?: string; value?: string }[] }[];
        effectiveConfig?: { sell?: { triggerPercentage?: string } };
        currentPrice?: string | null;
      };
    };
    // The candidate has to reach the merge, not just be echoed: a preview that ignored the override would answer for the live configuration and tell the operator their change does nothing. Compared against what the profile actually stores rather than a retyped default, so the two cannot agree by coincidence.
    const live = (strategy.status === 'unknown' ? {} : strategy.strategy.defaultConfig) as {
      sell?: { triggerPercentage?: string };
    };
    expect(live.sell?.triggerPercentage).not.toBe('1.20');
    expect(payload.result?.effectiveConfig?.sell?.triggerPercentage).toBe('1.20');
    // The levels themselves, not merely their container. The handler answers a throwing projection with `{ sections: [] }`, so an `Array.isArray` check passes even with `previewLevels` stubbed out entirely; only reaching a row proves the strategy was consulted.
    const rows = (payload.result?.sections ?? []).flatMap((section) => section.rows ?? []);
    expect(payload.result?.currentPrice).toBe('50000.00');
    expect(payload.result?.sections?.length ?? 0).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    // The half that makes it safe to hand an agent on the read scope. A preview that upserted the symbol row would bind a coin to the profile as a side effect of asking a question.
    const after = await fx.di.pool.query<{ n: string }>(
      `select count(*)::text as n from profile_symbols where profile_id = $1`,
      [fx.alice.profileId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    const stored = await fx.di.pool.query<{ config: { sell?: { triggerPercentage?: string } } }>(
      `select config from profiles where id = $1`,
      [fx.alice.profileId],
    );
    expect(stored.rows[0]?.config?.sell?.triggerPercentage).not.toBe('1.20');
  });
});
