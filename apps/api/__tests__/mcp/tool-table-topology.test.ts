import { describe, expect, it } from 'vitest';
import type { DI } from '../../src/di.js';
import {
  MCP_TOOLS,
  MCP_TOOLS_BY_NAME,
  NO_TOOL_DENIED,
  NO_TOOL_NOT_SURFACED,
} from '../../src/mcp/tools.js';
import { authRouter } from '../../src/routes/auth.js';
import { mountApiRouters } from '../../src/routes/mount.js';
import { createApiHono, type ApiHono } from '../../src/types.js';

interface MountedRoute {
  readonly method: string;
  readonly path: string;
}

/**
 * The fields the partition reads off one tool entry, declared structurally rather than imported, so this suite states the contract the tool table has to satisfy instead of inheriting whatever shape it happens to grow. A tool covers one or more route signatures because a handful of reads are deliberately consolidated, so the partition is over route signatures, never over tool names.
 */
interface ToolEntry {
  readonly name: string;
  readonly scope: string;
  readonly routes: readonly string[];
  readonly annotations: {
    readonly destructiveHint?: boolean;
  };
  readonly meta?: {
    readonly 'anthropic/requiresUserInteraction'?: boolean;
  };
}

const mountedApp = (): ApiHono => {
  const app = createApiHono();
  const di = {} as DI;
  app.route('/api/auth', authRouter(di));
  mountApiRouters(app, di);
  return app;
};

const signature = (route: MountedRoute): string => `${route.method} ${route.path}`;

/**
 * The signatures a request can actually terminate at. Hono records every `use()` mount as method `ALL`, and every endpoint in this app is declared through `openapi()` with a concrete method, so an `ALL` entry is always middleware: a wildcard prefix mount or a guard registered ahead of the handler it protects. Classifying one would put a non-endpoint into the partition and let a real endpoint hide behind its guard's signature.
 *
 * @param routes - The route table Hono exposes, or a synthetic stand-in used to fault-inject the detectors below.
 * @returns Deduplicated, sorted `'METHOD /path'` signatures of the terminal endpoints.
 */
const endpointSignatures = (routes: readonly MountedRoute[]): string[] =>
  [...new Set(routes.filter((route) => route.method !== 'ALL').map(signature))].sort();

/**
 * Every route signature the tool table dispatches to, flattened across tools and deduplicated: two tools legitimately naming the same read is not a partition defect, because the partition is about buckets.
 *
 * @param tools - The tool table under test.
 * @returns Sorted unique route signatures reachable through some tool.
 */
const toolBucket = (tools: readonly ToolEntry[]): string[] =>
  [...new Set(tools.flatMap((tool) => [...tool.routes]))].sort();

/**
 * The three buckets as parallel lists. The two withheld buckets are NOT deduplicated: a signature repeated inside one of them is an authoring mistake worth failing on, whereas a repeat across the tool bucket is the consolidation above.
 *
 * @param tools - The tool table under test.
 * @returns The tool bucket, the denied bucket and the not-surfaced bucket, in that order.
 */
const buckets = (tools: readonly ToolEntry[]): readonly (readonly string[])[] => [
  toolBucket(tools),
  NO_TOOL_DENIED,
  NO_TOOL_NOT_SURFACED,
];

const classifiedSignatures = (tools: readonly ToolEntry[]): string[] =>
  [...new Set(buckets(tools).flat())].sort();

/**
 * Mounted endpoints that no bucket names. This is the fail-closed half: a route added to the product without a bucket entry surfaces here, so the default for a new route is no tool at all rather than silent exposure.
 *
 * @param routes - Mounted or synthetic route table.
 * @param tools - The tool table under test.
 * @returns Sorted signatures of endpoints missing from all three buckets.
 */
const unclassifiedEndpoints = (
  routes: readonly MountedRoute[],
  tools: readonly ToolEntry[],
): string[] => {
  const classified = new Set(classifiedSignatures(tools));
  return endpointSignatures(routes).filter((sig) => !classified.has(sig));
};

/**
 * Bucket entries naming a route the app does not mount. Without this direction a renamed or deleted route leaves its entry behind, and the stale entry keeps describing a decision about something that no longer exists, ready to silently re-classify a future route that reuses the signature.
 *
 * @param routes - Mounted or synthetic route table.
 * @param tools - The tool table under test.
 * @returns Sorted bucket entries with no mounted endpoint behind them.
 */
const staleBucketEntries = (
  routes: readonly MountedRoute[],
  tools: readonly ToolEntry[],
): string[] => {
  const mounted = new Set(endpointSignatures(routes));
  return classifiedSignatures(tools).filter((sig) => !mounted.has(sig));
};

/**
 * Signatures claimed by more than one bucket. Set equality between "mounted" and "classified" would still accept a route listed as both tool-reachable and denied, which is the one arrangement that makes the denied bucket a lie.
 *
 * @param tools - The tool table under test.
 * @returns Sorted signatures counted more than once across the three buckets.
 */
const multiplyClassified = (tools: readonly ToolEntry[]): string[] => {
  const counts = new Map<string, number>();
  for (const bucket of buckets(tools)) {
    for (const sig of bucket) counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([sig]) => sig)
    .sort();
};

/**
 * Denied routes that some tool nonetheless dispatches to, computed from the two constants so this can never drift from a hand-copied inventory.
 *
 * @param tools - The tool table under test.
 * @returns Sorted denied signatures reachable through a tool.
 */
const deniedRoutesReachableByTool = (tools: readonly ToolEntry[]): string[] => {
  const denied = new Set(NO_TOOL_DENIED);
  return toolBucket(tools).filter((sig) => denied.has(sig));
};

const namesWithScope = (tools: readonly ToolEntry[], scope: string): string[] =>
  tools
    .filter((tool) => tool.scope === scope)
    .map((tool) => tool.name)
    .sort();

const namesAnnotatedDestructive = (tools: readonly ToolEntry[]): string[] =>
  tools
    .filter((tool) => tool.annotations.destructiveHint === true)
    .map((tool) => tool.name)
    .sort();

/** Read off `meta`, not `annotations`: the client ignores the key anywhere else, so a tool carrying it under `annotations` is not interaction-gated however it reads in the table. */
const namesMetaInteractive = (tools: readonly ToolEntry[]): string[] =>
  tools
    .filter((tool) => tool.meta?.['anthropic/requiresUserInteraction'] === true)
    .map((tool) => tool.name)
    .sort();

const splitSignature = (sig: string): MountedRoute => {
  const boundary = sig.indexOf(' ');
  return { method: sig.slice(0, boundary), path: sig.slice(boundary + 1) };
};

describe('MCP tool table topology', () => {
  it('places every mounted API endpoint in exactly one bucket', () => {
    const { routes } = mountedApp();

    expect(unclassifiedEndpoints(routes, MCP_TOOLS)).toEqual([]);
    expect(staleBucketEntries(routes, MCP_TOOLS)).toEqual([]);
    expect(multiplyClassified(MCP_TOOLS)).toEqual([]);
    // Exact equality in both directions, stated once so a future edit cannot satisfy one half by weakening the other.
    expect(endpointSignatures(routes)).toEqual(classifiedSignatures(MCP_TOOLS));
  });

  it('reports a newly mounted route that no bucket classifies', () => {
    // The detector above passes when the route table and the buckets happen to agree today. This proves it can still fail: an account-scoped write that nobody classified is exactly the route that must not acquire a tool by default.
    expect(
      unclassifiedEndpoints(
        [{ method: 'POST', path: '/api/accounts/:accountId/steal' }],
        MCP_TOOLS,
      ),
    ).toEqual(['POST /api/accounts/:accountId/steal']);

    // The discriminating half, drawn from the constant rather than retyped: an endpoint a bucket already names is not reported, so the detector is not simply flagging everything handed to it.
    const alreadyDenied = NO_TOOL_DENIED[0];
    expect(alreadyDenied).toBeDefined();
    expect(unclassifiedEndpoints([splitSignature(alreadyDenied ?? '')], MCP_TOOLS)).toEqual([]);
  });

  it('reports a bucket entry that names no mounted route', () => {
    // An empty route table makes every bucket entry stale. Without this the "nothing unclassified" half would still pass over a route table that had quietly emptied, since nothing unmounted can be unclassified.
    const stale = staleBucketEntries([], MCP_TOOLS);
    expect(stale.length).toBeGreaterThan(0);
    expect(stale).toEqual(classifiedSignatures(MCP_TOOLS));
  });

  it('exposes no tool that dispatches to a denied route', () => {
    // An empty denied bucket would satisfy the check below for want of anything to find, which is precisely the state a careless refactor leaves behind.
    expect(NO_TOOL_DENIED.length).toBeGreaterThan(0);
    expect(deniedRoutesReachableByTool(MCP_TOOLS)).toEqual([]);

    const denied = NO_TOOL_DENIED[0] ?? '';
    const smuggler: ToolEntry = {
      name: 'smuggle_denied_route',
      scope: 'mcp:trade',
      routes: [denied],
      annotations: { destructiveHint: true },
      meta: { 'anthropic/requiresUserInteraction': true },
    };
    expect(deniedRoutesReachableByTool([...MCP_TOOLS, smuggler])).toEqual([denied]);
    // A denied route smuggled in as a tool target is also double-counted, so the partition itself refuses it even if the dedicated check were deleted.
    expect(multiplyClassified([...MCP_TOOLS, smuggler])).toEqual([denied]);
  });

  it('marks trade tools destructive in annotations and interaction-gated in meta, and read tools neither', () => {
    const tradeNames = namesWithScope(MCP_TOOLS, 'mcp:trade');
    const readNames = namesWithScope(MCP_TOOLS, 'mcp:read');
    // Both halves of the implication need a population. Over two empty lists every equality below holds while asserting nothing, and a table carrying an unrecognised third scope would vanish from both sides at once.
    expect(tradeNames.length).toBeGreaterThan(0);
    expect(readNames.length).toBeGreaterThan(0);
    expect([...tradeNames, ...readNames].sort()).toEqual(MCP_TOOLS.map((tool) => tool.name).sort());

    expect(namesAnnotatedDestructive(MCP_TOOLS)).toEqual(tradeNames);
    expect(namesMetaInteractive(MCP_TOOLS)).toEqual(tradeNames);

    // Forward direction: a trade tool that forgets the hints drops out of the annotated set, so the model would get a one-tap approval on a real-money write.
    const bareTrade: ToolEntry = {
      name: 'bare_trade_tool',
      scope: 'mcp:trade',
      routes: [],
      annotations: {},
    };
    expect(namesAnnotatedDestructive([...MCP_TOOLS, bareTrade])).not.toEqual(
      namesWithScope([...MCP_TOOLS, bareTrade], 'mcp:trade'),
    );
    expect(namesMetaInteractive([...MCP_TOOLS, bareTrade])).not.toEqual(
      namesWithScope([...MCP_TOOLS, bareTrade], 'mcp:trade'),
    );

    // Reverse direction: a read tool marked destructive would teach the operator to approve prompts on reads, which is how a genuine write prompt stops being read.
    const destructiveRead: ToolEntry = {
      name: 'destructive_read_tool',
      scope: 'mcp:read',
      routes: [],
      annotations: { destructiveHint: true },
      meta: { 'anthropic/requiresUserInteraction': true },
    };
    expect(namesAnnotatedDestructive([...MCP_TOOLS, destructiveRead])).not.toEqual(
      namesWithScope([...MCP_TOOLS, destructiveRead], 'mcp:trade'),
    );
    expect(namesMetaInteractive([...MCP_TOOLS, destructiveRead])).not.toEqual(
      namesWithScope([...MCP_TOOLS, destructiveRead], 'mcp:trade'),
    );
  });
});

/**
 * The partition above is over route signatures the tool table DECLARES. A path argument that changes the path after the table has been consulted escapes it entirely, which is why these live here rather than beside the plan-shape cases.
 */
describe('a path parameter cannot rewrite the dispatched route', () => {
  const removeSymbol = (): { plan: (args: Record<string, unknown>) => { path: string } } => {
    const tool = MCP_TOOLS_BY_NAME.get('remove_symbol');
    expect(tool).toBeDefined();
    // Narrowed through an assertion rather than `?.`, because an optional call on a missing tool evaluates to undefined without throwing, and a `toThrow` case written that way fails for the wrong reason while a non-throwing one passes vacuously.
    if (!tool) throw new Error('remove_symbol is not in the tool table');
    return tool;
  };

  it('refuses a dot-segment symbol rather than dispatching a shortened path', () => {
    // `..` survives encodeURIComponent untouched, so it reaches `new Request()` as a dot segment the URL parser removes before Hono sees it, shortening this DELETE onto the profile path whose DELETE is a NO_TOOL_DENIED entry. That shortened path is not reachable today: the collapse always leaves a trailing slash and Hono's strict matching answers 404 for one. The refusal is here precisely because nothing in this repo asserts that default, so without it the denied bucket holds on a setting no test would notice being changed.
    expect(() => removeSymbol().plan({ accountId: 'a', profileId: 'p', symbol: '..' })).toThrow(
      /single path segment/,
    );

    // The discriminating half: a real pair still plans, so the guard refuses the traversal rather than the tool.
    expect(removeSymbol().plan({ accountId: 'a', profileId: 'p', symbol: 'BTCUSDT' }).path).toBe(
      '/api/accounts/a/profiles/p/symbols/BTCUSDT',
    );
  });

  it('refuses every other value that cannot be one segment', () => {
    // `.` collapses the same way one level shallower, and a separator is the form the encoder does neutralise today: refusing it keeps the property stated over the argument rather than over the encoder that currently happens to escape it.
    for (const symbol of ['.', '../..', 'a/b', 'a\\b']) {
      expect(() => removeSymbol().plan({ accountId: 'a', profileId: 'p', symbol })).toThrow(
        /single path segment/,
      );
    }
  });
});

/**
 * A consolidated read reaches several routes, and every route query schema in this app is a plain `z.object`, which strips an unknown key instead of rejecting it. The route-contract suite cannot see this: for a consolidated tool it accepts an argument that any one of the routes takes, so an argument belonging to a sibling kind reads as declared there and is dropped here.
 */
describe('a consolidated read refuses an argument its selected route would discard', () => {
  const plan = (name: string, args: Record<string, unknown>): (() => unknown) => {
    const tool = MCP_TOOLS_BY_NAME.get(name);
    expect(tool).toBeDefined();
    if (!tool) throw new Error(`${name} is not in the tool table`);
    return () => tool.plan(args);
  };

  it('refuses symbol on the profile log, which has no such filter', () => {
    // `ActionLogQuery` declares `symbols`, not `symbol`. Dropped, the answer is the WHOLE profile's log returned as though it had been filtered to one pair, which is the reading an agent cannot distinguish from a quiet symbol.
    expect(
      plan('get_logs', { accountId: 'a', profileId: 'p', kind: 'profile', symbol: 'BTCUSDT' }),
    ).toThrow(/symbol/);
  });

  it('refuses cursor on the tick trace, which pages by a stream id this tool does not expose', () => {
    // `TickTraceQuery` declares `symbol`, `limit` and `before`. A dropped `cursor` re-reads page one forever, so an agent walking back through a trace loops without ever being told.
    expect(
      plan('get_logs', { accountId: 'a', profileId: 'p', kind: 'tick-trace', cursor: 'x' }),
    ).toThrow(/cursor/);
  });

  it('refuses limit on candles and interval on depth, which read neither', () => {
    // Both directions of the same split, so the check is not simply rejecting whatever the first kind happens not to take.
    expect(
      plan('get_market_data', {
        accountId: 'a',
        profileId: 'p',
        symbol: 'BTCUSDT',
        kind: 'candles',
        limit: 10,
      }),
    ).toThrow(/limit/);
    expect(
      plan('get_market_data', {
        accountId: 'a',
        profileId: 'p',
        symbol: 'BTCUSDT',
        kind: 'depth',
        interval: '1h',
      }),
    ).toThrow(/interval/);
  });

  it('plans the same arguments unchanged where the selected route does declare them', () => {
    // Without this the cases above are satisfied by a plan that refuses everything, and the tools would be unusable rather than honest.
    const tool = MCP_TOOLS_BY_NAME.get('get_logs');
    expect(tool).toBeDefined();
    expect(
      tool?.plan({ accountId: 'a', profileId: 'p', kind: 'tick-trace', symbol: 'BTCUSDT' }),
    ).toMatchObject({
      path: '/api/accounts/a/profiles/p/tick-trace',
      query: { symbol: 'BTCUSDT' },
    });
    expect(
      tool?.plan({ accountId: 'a', profileId: 'p', kind: 'profile', q: 'halt' }),
    ).toMatchObject({ path: '/api/accounts/a/profiles/p/logs', query: { q: 'halt' } });
  });
});
