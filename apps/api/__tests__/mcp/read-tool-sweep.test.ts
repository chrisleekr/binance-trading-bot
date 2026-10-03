// Every read tool, actually called.
//
// Two tools shipped declaring arguments their own route refuses: the bulk fan-out spelled `side` in uppercase against a lowercase contract, and `get_closed_trades` advertised a `period` format the route has never accepted. Both were invisible to every other suite here, because the rest of this directory checks the tool TABLE rather than the tools, and a table can agree with itself while disagreeing with the router it dispatches into. Both were found by invoking them.
//
// What this sweeps for is one specific disagreement, stated narrowly so the result means something: a route requiring an argument the tool let the agent leave out. That is the shape of all three instances found so far, and zod reports it in a form that cannot be confused with anything else, `received undefined` against the missing path. A broader assertion over "any 422" would fold in the routes that legitimately reject CONTENT, such as a linter refusing a config, and a guard that cries wolf on those is a guard nobody reads.
//
// Read tools only. The write surface cannot be swept this way without arming real orders; its order-placing half is covered by `idempotency-settlement.test.ts` and the dispatch integration cases instead.
//
// What it does NOT catch, stated so the green is not read as more than it is: a tool declaring a WIDER type than its route accepts. `get_closed_trades` once took a free-text `period` whose description named a format the route rejects, and reverting that fix leaves this file green, because the sweep omits optional fields and so never sends the bad value. Closing that would need a tool-to-contract mapping which does not exist; the defence there is declaring such fields from the contract's own schema, as `period` now is, rather than restating them.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatchMcpTool, type McpDispatchDeps } from '../../src/mcp/dispatch.js';
import { MCP_SCOPE_READ } from '../../src/mcp/scopes.js';
import { MCP_TOOLS, type McpTool } from '../../src/mcp/tools.js';
import { HAS_INFRA, setupApp, type ApiFixture } from '../_helpers.js';

/** A syntactically valid id that owns nothing, so a route keyed by it answers "not found" rather than "malformed". The distinction is the point: 404 is a real answer, a shape complaint is not. */
const ABSENT_UUID = '00000000-0000-4000-8000-0000000000fe';

/**
 * Values for required fields this sweep cannot infer from a schema alone.
 *
 * Enumerated rather than inferred because the alternative is a synthesiser guessing at an id or a strategy config, and a guess that happens to be refused looks exactly like the defect this file hunts. Every entry says why the field needs one.
 */
const ARG_OVERRIDES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // Identifier of a run that has to exist to be fetched. An absent one answers 404, which this sweep accepts.
  get_backtest: { runId: ABSENT_UUID },
  get_backtest_advisor: { runId: ABSENT_UUID },
  get_diagnosis_run: { runId: ABSENT_UUID },
  // Naming the pairs is required, because the unnarrowed listing is megabytes of permission tags.
  get_exchange_info: { symbols: ['BTCUSDT'] },
  // The linter's whole job is to judge a config, so any config here is content it is entitled to reject. An empty object keeps the call well-formed, which is all this sweep asks of it.
  lint_config: { config: {} },
  // Candles need a window and an interval; the consolidated tool leaves them optional because its other kinds do not take them.
  get_market_data: {
    kind: 'candles',
    interval: '1h',
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-02T00:00:00.000Z',
  },
};

/**
 * Path parameters of the route this tool will actually dispatch to.
 *
 * A consolidated read picks its route from `kind`, and the tool table builds its route list and its `kind` enum from the same map, so the enum's position is the route's position.
 *
 * @param tool - Tool being swept.
 * @param kind - The `kind` value the sweep chose, or undefined on a tool that has no selector.
 * @returns Names of the `:param` segments in the selected signature.
 */
const pathParamsOf = (tool: McpTool, kind: unknown): readonly string[] => {
  const options = (tool.inputShape['kind'] as { options?: readonly unknown[] } | undefined)
    ?.options;
  const index = Array.isArray(options) ? options.indexOf(kind) : -1;
  const signature = tool.routes[index >= 0 ? index : 0] ?? '';
  return [...signature.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1] as string);
};

/**
 * Builds the smallest argument set a tool will accept.
 *
 * Only required fields are filled, plus whatever {@link ARG_OVERRIDES} names. An optional field left out is the call an agent makes when it has nothing to say about it, and it is the case most likely to be wrong, since a route that silently requires an "optional" argument fails exactly there.
 *
 * Path parameters are the one exception, filled whether the tool marks them optional or not. An unfilled one is refused while the call is planned, so it never reaches a route or its validator, and this sweep would learn nothing about the route. `lint_config` declares both of its ids optional and was once swept that way, against a path no route could ever serve.
 *
 * @param tool - Tool being swept, supplying its shape, its routes and its overrides.
 * @param fx - Fixture supplying real owned ids, so the call reaches validation rather than stopping at ownership.
 * @returns Arguments to dispatch with.
 */
const minimalArgs = (tool: McpTool, fx: ApiFixture): Record<string, unknown> => {
  const shape: Readonly<Record<string, z.ZodTypeAny>> = tool.inputShape;
  const overrides = ARG_OVERRIDES[tool.name] ?? {};
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    if (key in overrides) {
      args[key] = overrides[key];
      continue;
    }
    // An optional field accepts undefined, which is how it is detected without reaching into zod's internals.
    if (schema.safeParse(undefined).success) continue;
    args[key] = valueFor(key, schema, fx);
  }
  for (const name of pathParamsOf(tool, args['kind'])) {
    if (args[name] === undefined) args[name] = valueFor(name, shape[name] ?? z.string(), fx);
  }
  return args;
};

/**
 * Picks a value a required field will accept.
 *
 * Enums are answered from their own option list rather than from a guess, which is the point: a hand-written value here would reintroduce the second-spelling problem this file exists to catch.
 *
 * @param key - Field name, which decides the identifier-shaped values.
 * @param schema - The field's schema.
 * @param fx - Fixture supplying owned ids.
 * @returns A value the field should accept.
 */
const valueFor = (key: string, schema: z.ZodTypeAny, fx: ApiFixture): unknown => {
  if (key === 'accountId') return fx.alice.accountId;
  if (key === 'profileId') return fx.alice.profileId;
  if (key === 'symbol') return 'BTCUSDT';
  const options = (schema as unknown as { options?: readonly unknown[] }).options;
  if (Array.isArray(options) && options.length > 0) return options[0];
  if (schema.safeParse(1).success) return 1;
  if (schema.safeParse('a').success) return 'a';
  throw new Error(`read-tool-sweep has no representative value for required field ${key}`);
};

const READ_TOOLS = MCP_TOOLS.filter((tool) => tool.scope === MCP_SCOPE_READ);

describe.skipIf(!HAS_INFRA)('every read tool survives its own route validator', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
    // One bound symbol, so the symbol-scoped reads address something real rather than stopping at the binding check.
    await fx.di.pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source, pinned)
       values ($1, 'BTCUSDT', 'BTC', 'manual', true)
       on conflict do nothing`,
      [fx.alice.profileId],
    );
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('sweeps a non-empty set, so the cases below are not vacuous', () => {
    // A filter that matched nothing would make every assertion below pass without calling anything.
    expect(READ_TOOLS.length).toBeGreaterThan(20);
  });

  it('overrides only arguments that exist, so a renamed tool or field does not silently lose its value', () => {
    // An override keyed to a tool that no longer exists stops applying, and the sweep quietly reverts to guessing for it. A key naming an argument the tool never declared is the same failure one level down, and harder to see: `minimalArgs` consults an override only for a key already in the shape, so the entry sits there looking deliberate while being read by nothing. Checking the tool names alone enumerates the wrong collection and cannot tell either of these from a working override.
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
    const dead: string[] = [];
    for (const [name, overrides] of Object.entries(ARG_OVERRIDES)) {
      const tool = byName.get(name);
      if (tool === undefined) {
        dead.push(name);
        continue;
      }
      for (const field of Object.keys(overrides)) {
        if (!(field in tool.inputShape)) dead.push(`${name}.${field}`);
      }
    }
    expect(dead).toEqual([]);
  });

  for (const tool of READ_TOOLS) {
    it(`${tool.name} does not require an argument it let the agent omit`, async () => {
      const deps: McpDispatchDeps = {
        di: { ...fx.di, queue: { add: vi.fn() } as never },
        operatorId: fx.alice.userId,
        grantedScopes: new Set([MCP_SCOPE_READ]),
      };
      const args = minimalArgs(tool, fx);
      // The sweep's own floor, asserted per tool rather than as a count, because a count cannot say WHICH tool stopped arriving. A path holding an empty segment matches no route, so the two assertions below would pass over a call that never reached a validator at all.
      expect(tool.plan(args).path.split('/').slice(1)).not.toContain('');
      const result = await dispatchMcpTool(deps, tool.name, args);
      // The other half of the floor. Hono answers an unmatched path with the literal body `404 Not Found`, while a route's own 404 is the project error envelope, so this catches a path that is well-formed and still routes nowhere.
      expect(result.text).not.toContain('404 Not Found');
      // The narrow claim: nothing the route needs was left unrepresented by the tool. A 404, or a 422 about the CONTENT of an argument, is a real answer and not this file's business.
      expect(result.text).not.toContain('received undefined');
      expect(result.text).not.toContain('HTTP 400');
    });
  }
});
