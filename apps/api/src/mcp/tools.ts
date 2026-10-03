import {
  ArchiveSort,
  BacktestParamsSchema,
  BINANCE_KLINE_INTERVALS,
  ClosedTradesPeriod,
  DiscoveryConfigSchema,
  RiskConfigSchema,
} from '@app/contracts';
import { z } from 'zod';
import { HttpError } from '../middleware/error.js';
import { MCP_SCOPE_READ, MCP_SCOPE_TRADE, type McpScope } from './scopes.js';

/** Standard MCP behaviour hints. These are the only keys that belong here: `annotations` is the field every client understands, and it is defined over a fixed set of names. */
export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
}

/**
 * Client-specific hints, which Claude Code reads from the tool entry's `_meta` and from nowhere else.
 *
 * The same keys nested inside `annotations` are silently ignored, and silently is the whole problem: the tool listing still looks correct while `requiresUserInteraction` stops forcing a permission prompt on a real order and `maxResultSizeChars` stops raising the default output cap, so a large read comes back truncated. `requiresUserInteraction` is read strictly: only the JSON boolean `true` counts.
 */
export interface McpToolMeta {
  readonly 'anthropic/requiresUserInteraction'?: boolean;
  readonly 'anthropic/maxResultSizeChars'?: number;
}

/**
 * Both hint carriers as one value, because they are chosen together and must not be passed separately.
 *
 * `destructiveHint` and `anthropic/requiresUserInteraction` sit on every trade tool and on no read tool, but they ride in different wire fields: the first tells the model the call is not safely retryable, the second forces a full permission prompt instead of the one-tap approval a client may otherwise offer. Two independently-supplied fields is exactly how one of the pair goes missing. A read tool that carried either would train the operator to wave prompts through, which is how a real order gets approved unread.
 */
export interface McpToolHints {
  readonly annotations: McpToolAnnotations;
  readonly meta?: McpToolMeta;
}

/** One dispatchable HTTP call, already resolved from the tool's arguments. */
export interface McpRequestPlan {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>> | null;
}

export interface McpTool {
  readonly name: string;
  readonly scope: McpScope;
  readonly description: string;
  /**
   * Every `'METHOD /path'` this tool can dispatch to. Usually one; a handful of reads are deliberately consolidated so the model spends one tool definition rather than four on the same shape. This is the field the partition test reads, so a tool that grows a second target without listing it here fails the topology gate rather than quietly widening the surface.
   */
  readonly routes: readonly string[];
  readonly annotations: McpToolAnnotations;
  /** Served under the tool entry's `_meta`. Absent on a tool that asks for no client behaviour beyond the defaults, so nothing has to distinguish an empty object from no request at all. */
  readonly meta?: McpToolMeta;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  /** The same argument shape, unwrapped. The MCP SDK registers a tool from a raw shape rather than a built object, and reading `.shape` back off the object yields zod's readonly view, which its signature refuses. */
  readonly inputShape: Record<string, z.ZodType>;
  /** Resolves validated arguments into the call to dispatch. */
  readonly plan: (args: Readonly<Record<string, unknown>>) => McpRequestPlan;
  /** True where the dispatched route can put an order on Binance. Declared beside the tool rather than in a second list elsewhere, because the dispatcher reads it to decide that a retry without an idempotency key would be a second real order. */
  readonly placesOrder: boolean;
}

/** Raised to the client's default output cap for tools whose honest answer is a large document: schemas, exchange filters, dashboards, log pages. */
const LARGE_RESULT_CHARS = 500_000;

const READ_HINTS: McpToolHints = { annotations: { readOnlyHint: true } };
const LARGE_READ_HINTS: McpToolHints = {
  annotations: { readOnlyHint: true },
  meta: { 'anthropic/maxResultSizeChars': LARGE_RESULT_CHARS },
};
const WRITE_HINTS: McpToolHints = {
  annotations: { destructiveHint: true },
  meta: { 'anthropic/requiresUserInteraction': true },
};

/** Consumed by the idempotency layer before dispatch, so it must never reach the upstream route as a body field. */
const RESERVED_ARGS: ReadonlySet<string> = new Set(['idempotencyKey', 'kind']);

const splitSignature = (signature: string): { method: string; template: string } => {
  const boundary = signature.indexOf(' ');
  return { method: signature.slice(0, boundary), template: signature.slice(boundary + 1) };
};

const PATH_PARAM = /:([A-Za-z][A-Za-z0-9]*)/g;

/**
 * Whether a path-parameter value stays inside the one segment its placeholder occupies.
 *
 * `encodeURIComponent` escapes a separator but leaves `.` alone, so a `..` argument reaches the URL intact and the URL parser removes the dot segment before any router sees the path, which is how a tool's own route silently becomes a shorter one the tool does not declare. Nothing is reachable that way today: the collapse always leaves a trailing slash and Hono's `strict` default answers 404 for `/x/` where it routes `/x`. That makes this defence in depth rather than a live bypass, and the reason to keep it is that the fail-closed partition otherwise rests entirely on a router default nothing in this repo asserts. An empty value is not judged here; `planFrom` refuses it by name first.
 *
 * @param value - The argument as it would be substituted, before encoding.
 * @returns True when the value can only ever be one path segment.
 */
const isSinglePathSegment = (value: string): boolean =>
  !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';

/**
 * The placeholder names a route template fills from arguments, so the rest can be checked against what the route actually reads.
 *
 * @param template - The route path, with `:param` placeholders.
 * @returns The placeholder names, without their colons.
 */
const pathParamNames = (template: string): ReadonlySet<string> =>
  new Set([...template.matchAll(PATH_PARAM)].map((match) => match[1] as string));

/**
 * Turns one route signature plus validated arguments into a concrete call.
 *
 * Path parameters are filled from same-named arguments and everything left over becomes a query string on a read or a JSON body on a write, which is the shape every route in this app already uses. Doing it structurally rather than per tool is what keeps 68 tools from carrying 68 hand-written request builders that can each drift from their route.
 *
 * A path argument that cannot be one segment is refused here rather than encoded, for the reason {@link isSinglePathSegment} gives.
 *
 * @param signature - The `'METHOD /path'` to dispatch, with `:param` placeholders.
 * @param args - Arguments already validated against the tool's input schema.
 * @returns The resolved method, path, query and body.
 */
const planFrom = (signature: string, args: Readonly<Record<string, unknown>>): McpRequestPlan => {
  const { method, template } = splitSignature(signature);
  const consumed = new Set<string>(RESERVED_ARGS);
  const path = template.replace(PATH_PARAM, (_match, name: string) => {
    consumed.add(name);
    const value = String(args[name] ?? '');
    // A consolidated tool declares a path argument optional when only some of its kinds take it, so an omitted one reaches here. Filled in as an empty segment it matches no route, and the caller would get a bare 404 it could read as "nothing there" rather than as its own missing argument.
    if (value === '') {
      throw new HttpError(
        'VALIDATION_FAILED',
        `${name} is required for this call. Pass it and call again.`,
      );
    }
    if (!isSinglePathSegment(value)) {
      throw new HttpError(
        'VALIDATION_FAILED',
        `${name} must name a single path segment, and ${JSON.stringify(value)} does not. Pass the identifier itself, with no path separator and no dot segment.`,
      );
    }
    return encodeURIComponent(value);
  });
  const rest = Object.entries(args).filter(
    ([key, value]) => !consumed.has(key) && value !== undefined,
  );
  if (method === 'GET' || method === 'DELETE') {
    const query: Record<string, string> = {};
    for (const [key, value] of rest) {
      query[key] = Array.isArray(value) ? value.join(',') : String(value);
    }
    return { method, path, query, body: null };
  }
  return { method, path, query: {}, body: Object.fromEntries(rest) };
};

const accountArg = {
  accountId: z.string().min(1).describe('Account to act on; list_accounts first if unsure.'),
};
const profileArgs = {
  ...accountArg,
  profileId: z.string().min(1).describe('Profile within that account.'),
};
const symbolArgs = {
  ...profileArgs,
  symbol: z.string().min(1).describe('Trading pair, for example BTCUSDT.'),
};
const pageArgs = {
  limit: z.number().int().positive().max(500).optional(),
  cursor: z.string().optional(),
};
/** Routes that page by row count alone. A `cursor` here would be accepted by the tool and dropped on the floor by the route, which reads as "there are no more rows". */
const limitOnlyArgs = { limit: pageArgs.limit };

/**
 * Restates one contract field as a tool argument the caller may omit.
 *
 * A stored-config schema gives every field a default so a partial row still parses. Spread into a tool as-is, those defaults are materialised by the tool's own validation, so a caller that sets one setting silently sends the default for every other one. Stripping the default and marking the field optional keeps an unsent field unsent, which is the only form in which the caller's intent survives to the route.
 *
 * @param schema - The contract's field schema, possibly wrapped in one or more defaults.
 * @returns The same field, defaultless and optional.
 */
const asOptionalArg = (schema: z.ZodType): z.ZodType => {
  let current = schema;
  while (current instanceof z.ZodDefault) current = current.def.innerType as z.ZodType;
  return current.optional();
};

/**
 * Restates a stored-config schema as the tool's argument set.
 *
 * Both config routes take the WHOLE stored object as their body and write it to the column verbatim, so a field left out is not preserved, it is replaced by its default. The tool therefore has to be able to name every field, or a caller adjusting one setting silently resets the rest. Derived from the route's own schema so the two cannot come to list different fields.
 *
 * @param schema - The route's body schema, wrapped in the parsed-default helper the stored configs use.
 * @returns One optional, defaultless argument per field.
 */
const storedConfigArgs = (schema: { def: { innerType: unknown } }): Record<string, z.ZodType> =>
  Object.fromEntries(
    Object.entries((schema.def.innerType as z.ZodObject<z.ZodRawShape>).shape).map(
      ([name, field]) => [name, asOptionalArg(field as z.ZodType)],
    ),
  );

const discoveryConfigArgs = storedConfigArgs(DiscoveryConfigSchema);
const riskConfigArgs = storedConfigArgs(RiskConfigSchema);

interface ToolInput {
  readonly name: string;
  readonly signature: string;
  readonly description: string;
  readonly shape?: Record<string, z.ZodType>;
  readonly hints?: McpToolHints;
  readonly placesOrder?: boolean;
}

const readTool = (input: ToolInput): McpTool => ({
  name: input.name,
  scope: MCP_SCOPE_READ,
  description: input.description,
  routes: [input.signature],
  ...(input.hints ?? READ_HINTS),
  inputSchema: z.object(input.shape ?? {}),
  inputShape: input.shape ?? {},
  plan: (args) => planFrom(input.signature, args),
  placesOrder: false,
});

const writeTool = (input: ToolInput): McpTool => ({
  name: input.name,
  scope: MCP_SCOPE_TRADE,
  description: input.description,
  routes: [input.signature],
  ...WRITE_HINTS,
  inputSchema: z.object(input.shape ?? {}),
  inputShape: input.shape ?? {},
  plan: (args) => planFrom(input.signature, args),
  placesOrder: input.placesOrder ?? false,
});

/**
 * One view of a consolidated read: the route it dispatches to, and the tool arguments that route actually reads.
 *
 * `args` is enforcement, not documentation. Every route query schema in this app is a plain `z.object`, which STRIPS an unknown key instead of rejecting it, so an argument the selected route does not declare is dropped in silence and the caller is answered as though it had been honoured. That is the difference between one symbol's log and the whole profile's log presented as filtered, and between paging a trace and re-reading its first page forever.
 */
interface ConsolidatedKind {
  /** The `'METHOD /path'` this kind dispatches to. */
  readonly route: string;
  /** Names taken from that route's own query or body schema. Path parameters are excluded: the template consumes those, and it consumes them for whichever kind is selected. */
  readonly args: readonly string[];
}

/**
 * Arguments the caller supplied that the selected route has no field for.
 *
 * @param kind - The selected view, carrying the route and the names it reads.
 * @param args - Arguments already validated against the tool's input schema.
 * @returns Sorted names that would reach the route and be discarded by it.
 */
const strayArgs = (kind: ConsolidatedKind, args: Readonly<Record<string, unknown>>): string[] => {
  const taken = pathParamNames(kind.route);
  const declared = new Set(kind.args);
  return Object.keys(args)
    .filter(
      (name) =>
        args[name] !== undefined &&
        !RESERVED_ARGS.has(name) &&
        !taken.has(name) &&
        !declared.has(name),
    )
    .sort();
};

/**
 * A read whose answer lives behind several routes of identical shape, selected by a flat `kind` enum.
 *
 * The enum is flat and top-level rather than a root-level `anyOf`, because clients flatten those and the model then sees a union it cannot choose from. The cost of that flattening is that every argument of every kind is declared on one schema, so the schema can no longer say which kind reads which: that is what {@link ConsolidatedKind} restores, and it is checked at dispatch because a description alone is a request, not a guarantee.
 *
 * @param input - Tool identity, description and argument shape, minus the selector.
 * @param byKind - Map from the `kind` value to the route it dispatches to and the arguments that route reads.
 * @returns The consolidated tool, declaring every route it can reach.
 */
const consolidatedRead = (
  input: Omit<ToolInput, 'signature'>,
  byKind: Readonly<Record<string, ConsolidatedKind>>,
): McpTool => {
  const kinds = Object.keys(byKind);
  const shape: Record<string, z.ZodType> = {
    ...(input.shape ?? {}),
    kind: z.enum(kinds as [string, ...string[]]).describe('Which view to return.'),
  };
  return {
    name: input.name,
    scope: MCP_SCOPE_READ,
    description: input.description,
    routes: Object.values(byKind).map((kind) => kind.route),
    ...(input.hints ?? READ_HINTS),
    inputSchema: z.object(shape),
    inputShape: shape,
    plan: (args) => {
      const name = String(args['kind'] ?? kinds[0] ?? '');
      const selected = byKind[name];
      if (selected === undefined) {
        throw new HttpError(
          'VALIDATION_FAILED',
          `${input.name} has no kind ${JSON.stringify(name)}. Valid kinds: ${kinds.join(', ')}.`,
        );
      }
      const stray = strayArgs(selected, args);
      if (stray.length > 0) {
        const reads =
          selected.args.length > 0
            ? `reads only ${selected.args.join(', ')}`
            : 'reads no arguments';
        throw new HttpError(
          'VALIDATION_FAILED',
          `${input.name} with kind=${name} ${reads} beyond the account, profile and symbol it addresses, so ${stray.join(', ')} would be discarded and the answer would come back looking like it had been honoured. Drop ${stray.length > 1 ? 'them' : 'it'}, or ask a kind that reads ${stray.length > 1 ? 'them' : 'it'}.`,
        );
      }
      return planFrom(selected.route, args);
    },
    placesOrder: false,
  };
};

const ACCOUNTS = '/api/accounts/:accountId';
const PROFILE = `${ACCOUNTS}/profiles/:profileId`;
const SYMBOL = `${PROFILE}/symbols/:symbol`;

/**
 * The complete agent-facing surface: 34 reads on `mcp:read`, 34 writes on `mcp:trade`.
 *
 * Writes are 1:1 with the action they perform and explicitly named, because the permission prompt and the audit row should say exactly what happened. A generic verb with a `kind` parameter would let the single most dangerous call in the set, a market fan-out across every bound symbol, arrive looking like every other write. Reads are consolidated only where the routes return the same shape and the model would otherwise spend four tool definitions on one question.
 */
export const MCP_TOOLS: readonly McpTool[] = [
  readTool({
    name: 'list_accounts',
    signature: 'GET /api/accounts',
    description:
      'Every Binance account this operator owns, each with its binanceMode (test or live) and whether an API key is attached. Call this FIRST: testnet and live accounts share the same tables and the same tool surface, so acting on the wrong accountId spends real money with no other warning.',
  }),
  readTool({
    name: 'get_account',
    signature: `GET ${ACCOUNTS}`,
    description: 'One account: its name, Binance environment, and creation time.',
    shape: accountArg,
  }),
  readTool({
    name: 'get_system_status',
    signature: 'GET /api/status',
    description:
      'Process health for the whole stack: api build SHA, worker heartbeat, fleet size, last applied migration. Check this before concluding that missing data is a trading problem.',
  }),
  readTool({
    name: 'get_account_health',
    signature: `GET ${ACCOUNTS}/account/health`,
    description:
      'Whether this account can currently reach Binance and read its wallet, including the user-data stream state.',
    shape: accountArg,
  }),
  readTool({
    name: 'get_api_key_status',
    signature: `GET ${ACCOUNTS}/api-key`,
    description:
      'Verification state of the account API key and the last four characters of the key id. The secret is not part of this response and cannot be read through any tool. A failed key verification is the usual cause of orders that never place.',
    shape: accountArg,
  }),
  readTool({
    name: 'list_strategies',
    signature: 'GET /api/strategies',
    description:
      'Every installed strategy with its full draft-07 configSchema, the per-symbol overrideConfigSchema, a complete defaultConfig, and the operator actions it supports. This is the authoritative description of every setting you may change: read it before writing any config, and never invent a field name.',
    hints: LARGE_READ_HINTS,
  }),
  readTool({
    name: 'get_exchange_info',
    signature: 'GET /api/exchange-info',
    description:
      'Binance symbol filters for the pairs you name: lot size, step size, tick size and minimum notional. An order that ignores these is rejected by the exchange, not by this bot. Naming the pairs is required because Binance lists thousands and returning all of them is megabytes of permission tags. Filters are read from the production exchange for every account, including a testnet one, where a few differ.',
    shape: {
      symbols: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe('Pairs to return filters for, for example ["BTCUSDT"].'),
    },
    hints: LARGE_READ_HINTS,
  }),
  readTool({
    name: 'get_market_trend',
    signature: 'GET /api/market-trend',
    description: 'Aggregate market direction the discovery and entry gates read.',
  }),
  readTool({
    name: 'list_profiles',
    signature: `GET ${ACCOUNTS}/profiles`,
    description:
      'Strategy profiles bound to this account. Profiles share the account wallet, so two profiles trading the same quote asset compete for the same cash.',
    shape: accountArg,
  }),
  readTool({
    name: 'get_profile',
    signature: `GET ${PROFILE}`,
    description: 'One profile including its live strategy configuration and run state.',
    shape: profileArgs,
  }),
  {
    ...readTool({
      name: 'get_dashboard',
      signature: `GET ${PROFILE}/dashboard`,
      description:
        'The main situational-awareness read: open positions, unrealised P/L, wallet balances, per-symbol state, and whether the profile-wide kill switch is on. Check killSwitch before concluding a quiet profile is simply waiting: with it set, nothing enters a position no matter what the per-symbol flags say. Balances list only held assets plus the quote asset unless balances=all is passed.',
      shape: {
        ...profileArgs,
        balances: z
          .enum(['held', 'all'])
          .optional()
          .describe(
            'held (default): assets with a free or locked amount, plus the quote asset. all: every asset Binance lists, about 800 rows, mostly zero.',
          ),
      },
      hints: LARGE_READ_HINTS,
    }),
    // Defaults to held here, not in the route: the route default stays `all` for the SPA, while an agent pays for every row in its context, and the zero rows carry nothing.
    plan: (args) => planFrom(`GET ${PROFILE}/dashboard`, { balances: 'held', ...args }),
  },
  readTool({
    name: 'get_closed_trades',
    signature: `GET ${PROFILE}/closed-trades`,
    description: 'Completed trades over a period, with realised profit and loss.',
    shape: {
      ...profileArgs,
      // Declared from the route's own enum rather than as free text. A loose string here meant the description carried the only statement of what was legal, and it named a format the route has never accepted, so an agent following it was refused every time. Reusing the contract makes the invalid call unrepresentable instead of merely discouraged.
      period: ClosedTradesPeriod.optional().describe(
        'Period to summarise: a = all time, d = today, w = this week, m = this month.',
      ),
      tz: z.string().optional().describe('IANA timezone for day bucketing.'),
    },
  }),
  readTool({
    name: 'get_equity_snapshots',
    signature: `GET ${PROFILE}/equity-snapshots`,
    description: 'Account equity over time, for drawdown and performance questions.',
    shape: {
      ...profileArgs,
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.number().int().positive().max(5000).optional(),
    },
  }),
  readTool({
    name: 'list_symbols',
    signature: `GET ${PROFILE}/symbols`,
    description:
      'Which symbols are bound to this profile, how each was added, and any per-symbol configuration override. It carries no position or enablement state: read get_dashboard for those across the profile, or get_symbol for one pair.',
    shape: profileArgs,
  }),
  consolidatedRead(
    {
      name: 'get_symbol',
      description:
        'One bound symbol. kind=summary returns its configuration and per-symbol override; kind=state returns the live strategy state for the position. Ask for both when diagnosing what a position is doing.',
      shape: symbolArgs,
    },
    {
      summary: { route: `GET ${SYMBOL}`, args: [] },
      state: { route: `GET ${SYMBOL}/state`, args: [] },
    },
  ),
  consolidatedRead(
    {
      name: 'get_market_data',
      // Four routes with different required arguments behind one tool, so the fields cannot be declared required here without breaking the three kinds that do not take them. That leaves the description as the only place the agent is told which kind needs what, and it has to say so: omitting them on `candles` is otherwise a refusal the caller had no way to anticipate.
      description:
        'Market data for one symbol: candles, ticker, recent trades, or order-book depth. Four views of the same pair behind one tool. kind=candles additionally REQUIRES interval, from and to, and is bounded by that window rather than by limit; kind=trades and kind=depth take limit and nothing else; kind=ticker takes neither. An argument the selected kind does not read is refused rather than silently ignored.',
      shape: {
        ...symbolArgs,
        // Built from the canonical tuple the kline endpoints are defined over, so the tool cannot come to list a different set from the route it posts to.
        interval: z
          .enum(BINANCE_KLINE_INTERVALS)
          .optional()
          .describe('Candle interval. Required when kind=candles.'),
        from: z
          .string()
          .optional()
          .describe('ISO-8601 start of the candle window. Required when kind=candles.'),
        to: z
          .string()
          .optional()
          .describe('ISO-8601 end of the candle window. Required when kind=candles.'),
        // Capped at the larger of the two route ceilings rather than at Binance's, because no kind here reads more than the depth ladder. A `trades` call above 50 is refused by its route, which is the honest answer: silently serving a different count than was asked for is what this bound exists to stop.
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe(
            'Rows to return: order-book levels per side when kind=depth (max 100), recent trades when kind=trades (max 50). Not read by kind=ticker or kind=candles.',
          ),
      },
      hints: LARGE_READ_HINTS,
    },
    {
      candles: { route: `GET ${SYMBOL}/candles`, args: ['interval', 'from', 'to'] },
      ticker: { route: `GET ${SYMBOL}/ticker`, args: [] },
      trades: { route: `GET ${SYMBOL}/trades`, args: ['limit'] },
      depth: { route: `GET ${SYMBOL}/depth`, args: ['limit'] },
    },
  ),
  readTool({
    name: 'list_orders',
    signature: `GET ${SYMBOL}/orders`,
    description:
      'Orders recorded for this symbol, newest first. The id here is this bot local row id, which is what cancel_order takes, not the Binance order id.',
    shape: { ...symbolArgs, ...limitOnlyArgs },
  }),
  readTool({
    name: 'list_trade_archive',
    signature: `GET ${PROFILE}/trade-archive`,
    description: 'Realised trade history with fees and profit basis.',
    shape: {
      ...profileArgs,
      symbol: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      sort: ArchiveSort.optional(),
      dir: z.enum(['asc', 'desc']).optional(),
      ...pageArgs,
    },
    hints: LARGE_READ_HINTS,
  }),
  readTool({
    name: 'get_risk',
    signature: `GET ${PROFILE}/risk`,
    description:
      'Risk configuration AND the live breaker state: whether trading is halted, which limits tripped, and when they reset. A halted profile places nothing regardless of what you ask it to do.',
    shape: profileArgs,
  }),
  consolidatedRead(
    {
      name: 'get_discovery',
      description:
        'Automatic symbol discovery. kind=candidates returns the current candidates, entry blockers and available quote cash; kind=funnel returns why candidates were rejected at each stage.',
      shape: profileArgs,
    },
    {
      candidates: { route: `GET ${PROFILE}/discovery`, args: [] },
      funnel: { route: `GET ${PROFILE}/discovery/funnel`, args: [] },
    },
  ),
  consolidatedRead(
    {
      name: 'get_logs',
      // Three routes with three different filter sets behind one tool, and the flattened schema cannot say which argument belongs to which kind, so the description has to. A filter the selected route does not declare is now refused instead of dropped, and a caller that has not been told the split reads that refusal as the tool being broken.
      description:
        'Diagnostics. kind=profile returns the profile log, kind=symbol the log for one symbol, kind=tick-trace the per-tick decision trace that explains why a strategy did or did not act. The three read different filters and anything outside the selected set is refused rather than silently ignored. kind=profile takes from, to, levels, symbols, q, limit and cursor. kind=symbol takes symbol, and REQUIRES both from and to. kind=tick-trace takes symbol, limit and before: with symbol set it scans back up to 2000 entries for that pair, and a page shorter than limit with a non-null oldestStreamId means the scan stopped there, so pass oldestStreamId as before to keep reading; a null oldestStreamId means the read reached the start of the stream.',
      shape: {
        ...profileArgs,
        symbol: z
          .string()
          .optional()
          .describe(
            'Required when kind=symbol, where it names the log to read. Optional when kind=tick-trace, where it narrows the trace to one pair. Not read by kind=profile, which filters by symbols instead.',
          ),
        from: z
          .string()
          .optional()
          .describe(
            'ISO-8601 start of the window. Required when kind=symbol, optional for kind=profile, not read by kind=tick-trace.',
          ),
        to: z
          .string()
          .optional()
          .describe(
            'ISO-8601 end of the window. Required when kind=symbol, optional for kind=profile, not read by kind=tick-trace.',
          ),
        levels: z.array(z.string()).optional().describe('Severity filter. kind=profile only.'),
        symbols: z.array(z.string()).optional().describe('Symbol filter. kind=profile only.'),
        q: z.string().optional().describe('Free-text filter. kind=profile only.'),
        limit: pageArgs.limit.describe('Rows to return. Not read by kind=symbol.'),
        cursor: pageArgs.cursor.describe('Page token from a previous answer. kind=profile only.'),
        before: z
          .string()
          .optional()
          .describe(
            'oldestStreamId from a previous tick-trace answer, to read entries older than it. kind=tick-trace only.',
          ),
      },
      hints: LARGE_READ_HINTS,
    },
    {
      // Read off each route's own query schema. `profile` is the action-log filter set, `symbol` is a required time range and nothing else, and the tick trace pages by a Redis stream id passed as `before`, never by the action-log `cursor`.
      profile: {
        route: `GET ${PROFILE}/logs`,
        args: ['from', 'to', 'levels', 'symbols', 'q', 'limit', 'cursor'],
      },
      symbol: { route: `GET ${SYMBOL}/logs`, args: ['from', 'to'] },
      'tick-trace': { route: `GET ${PROFILE}/tick-trace`, args: ['symbol', 'limit', 'before'] },
    },
  ),
  consolidatedRead(
    {
      name: 'lint_config',
      description:
        'Dry-run a candidate strategy configuration and report settings that are invalid, inert, or contradicted by another setting. Writes nothing. Deliberately a read tool, so you can validate a configuration without holding trade scope. The two kinds are addressed differently and each refuses the other identifiers rather than ignoring them: kind=profile lints against a live profile and takes accountId and profileId, kind=strategy lints a strategy in the abstract and takes name. Both take config.',
      shape: {
        accountId: z.string().optional().describe('Required when kind=profile; omit otherwise.'),
        profileId: z.string().optional().describe('Required when kind=profile; omit otherwise.'),
        name: z
          .string()
          .optional()
          .describe('Strategy name; required when kind=strategy, omit otherwise.'),
        config: z.record(z.string(), z.unknown()).describe('The candidate configuration.'),
      },
    },
    {
      // Both routes take the same one-field body, and each kind's identifiers are its own path parameters, so the other kind's would land in that body and be stripped by it.
      profile: { route: `POST ${PROFILE}/lint-config`, args: ['config'] },
      strategy: { route: 'POST /api/strategies/:name/lint-config', args: ['config'] },
    },
  ),
  readTool({
    name: 'preview_config',
    signature: `POST ${SYMBOL}/preview-config`,
    description:
      'Project the levels a configuration would actually place for this symbol, without persisting anything. Pass a candidate override to preview it, or omit config to preview what is live now. This is the step that answers "what will this setting do" before you commit it.',
    shape: {
      ...symbolArgs,
      config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Candidate per-symbol override; omit to preview the live configuration.'),
    },
  }),
  readTool({
    name: 'get_gate_status',
    signature: `GET ${PROFILE}/gate-status`,
    description:
      'Whether the live configuration matches the one a backtest proved, by configuration fingerprint.',
    shape: profileArgs,
  }),
  readTool({
    name: 'get_override',
    signature: `GET ${SYMBOL}/override`,
    description: 'The pending manual override for this symbol, if the worker has not consumed it.',
    shape: symbolArgs,
  }),
  readTool({
    name: 'list_orphan_orders',
    signature: `GET ${ACCOUNTS}/orphan-orders`,
    description:
      'Orders live on Binance that this bot has no record of, usually placed by hand in the Binance app.',
    shape: accountArg,
  }),
  readTool({
    name: 'list_audit_logs',
    signature: `GET ${PROFILE}/audit-logs`,
    description:
      'Who changed what, and when. Actions you take through these tools appear here with actor=agent.',
    shape: { ...profileArgs, ...pageArgs },
  }),
  readTool({
    name: 'get_technicals_recommendations',
    signature: `GET ${PROFILE}/technicals/recommendations`,
    description: 'Locally computed technical ratings the entry gate consults.',
    shape: profileArgs,
  }),
  readTool({
    name: 'list_backtests',
    signature: `GET ${PROFILE}/backtests`,
    description: 'Backtest runs for this profile, newest first.',
    shape: { ...profileArgs, ...pageArgs },
  }),
  readTool({
    name: 'get_backtest',
    signature: `GET ${PROFILE}/backtests/:runId`,
    description: 'One backtest run: parameters, progress and results.',
    shape: { ...profileArgs, runId: z.string().min(1) },
    hints: LARGE_READ_HINTS,
  }),
  readTool({
    name: 'get_backtest_advisor',
    signature: `GET ${PROFILE}/backtests/:runId/advisor`,
    description: 'Saved AI advisor suggestions for a backtest run. Reading costs nothing.',
    shape: { ...profileArgs, runId: z.string().min(1) },
  }),
  readTool({
    name: 'list_diagnosis_runs',
    signature: `GET ${PROFILE}/diagnosis/runs`,
    description: 'Past profile-diagnosis runs.',
    shape: { ...profileArgs, ...limitOnlyArgs },
  }),
  readTool({
    name: 'get_diagnosis_run',
    signature: `GET ${PROFILE}/diagnosis/runs/:runId`,
    description: 'One diagnosis run with its findings.',
    shape: { ...profileArgs, runId: z.string().min(1) },
    hints: LARGE_READ_HINTS,
  }),
  readTool({
    name: 'get_dust_eligible',
    signature: `GET ${PROFILE}/dust-transfer`,
    description:
      'Balances too small to sell that Binance will convert to BNB. Always empty on a testnet account, where Binance does not offer the endpoint this reads.',
    shape: profileArgs,
  }),

  writeTool({
    name: 'place_manual_order',
    placesOrder: true,
    signature: `POST ${SYMBOL}/manual-order`,
    description:
      'Place one real order on Binance for this symbol. Spends real funds when the account binanceMode is live. Give exactly one of quantity or quoteAmount, and price only for a LIMIT order. A BUY is refused while the entry halt is active.',
    shape: {
      ...symbolArgs,
      idempotencyKey: z
        .string()
        .min(8)
        .describe(
          'Unique per intended order. Retrying with the same key returns the first outcome instead of placing a second order.',
        ),
      side: z.enum(['BUY', 'SELL']),
      type: z.enum(['MARKET', 'LIMIT']),
      quantity: z.string().optional().describe('Base-asset amount, as a decimal string.'),
      quoteAmount: z.string().optional().describe('Quote-asset amount, as a decimal string.'),
      price: z.string().optional().describe('Limit price, as a decimal string. LIMIT only.'),
    },
  }),
  writeTool({
    name: 'place_market_order_all_symbols',
    placesOrder: true,
    signature: `POST ${PROFILE}/manual-order-all`,
    description:
      'THE MOST DANGEROUS TOOL HERE. Places a MARKET order on EVERY symbol in this profile matching the given quote asset, all at once, at whatever price the book gives. There is no per-symbol confirmation and no dry run. Spends real funds when the account is live.',
    shape: {
      ...profileArgs,
      idempotencyKey: z.string().min(8).describe('Unique per intended fan-out.'),
      quote: z.string().min(1).describe('Quote asset, for example USDT.'),
      // Lowercase because `ManualOrderAllRequest` spells this side lowercase, unlike every other order surface, which reuses the uppercase `OrderSide`. The tool shape has to match the contract it posts to, and the arguments reach the body verbatim.
      side: z.enum(['buy', 'sell']),
      marketQuantity: z.string().optional(),
      quoteAmount: z.string().optional(),
    },
  }),
  writeTool({
    name: 'cancel_order',
    signature: `POST ${SYMBOL}/cancel-order`,
    description:
      'Cancel one resting order. orderId is the local row id from list_orders, not the Binance order id.',
    shape: { ...symbolArgs, orderId: z.string().min(1) },
  }),
  writeTool({
    name: 'trigger_buy',
    placesOrder: true,
    signature: `POST ${SYMBOL}/trigger-buy`,
    description:
      'Force the strategy buy path on the next tick with the technicals gate treated as open. Places a real order if the strategy decides to.',
    shape: { ...symbolArgs, idempotencyKey: z.string().min(8) },
  }),
  writeTool({
    name: 'trigger_sell',
    placesOrder: true,
    signature: `POST ${SYMBOL}/trigger-sell`,
    description: 'Force the strategy sell path on the next tick. Places a real order.',
    shape: { ...symbolArgs, idempotencyKey: z.string().min(8) },
  }),
  writeTool({
    name: 'force_eject',
    placesOrder: true,
    signature: `POST ${SYMBOL}/force-eject`,
    description:
      'Sell out of this symbol and put it in a flatten cooldown so the strategy does not re-enter. Set blocklist to keep it permanently barred.',
    shape: { ...symbolArgs, idempotencyKey: z.string().min(8), blocklist: z.boolean().optional() },
  }),
  writeTool({
    name: 'cancel_pending_override',
    signature: `DELETE ${SYMBOL}/override`,
    description:
      'Withdraw a manual override the worker has not consumed yet. Returns a conflict if the worker already claimed it, which means the action is going ahead. Success does not prove there was one to withdraw: cancelling nothing answers the same way, so read get_override if you need to know what was pending.',
    shape: symbolArgs,
  }),
  writeTool({
    name: 'set_avg_entry_price',
    signature: `PUT ${SYMBOL}/avg-entry-price`,
    description:
      'Overwrite the recorded cost basis for this position. Nothing errors when this is wrong: every later profit figure and every exit decision silently reads the value you set here. Only use it when you know the true fill price and the bot does not.',
    shape: { ...symbolArgs, avgEntryPrice: z.string().min(1) },
  }),
  writeTool({
    name: 'clear_avg_entry_price',
    signature: `DELETE ${SYMBOL}/avg-entry-price`,
    description: 'Remove a manually set cost basis and fall back to the reconstructed one.',
    shape: symbolArgs,
  }),
  writeTool({
    name: 'archive_grid_trade',
    signature: `POST ${SYMBOL}/archive-grid-trade`,
    description: 'Close out the current grid cycle into the trade archive and start a fresh one.',
    shape: symbolArgs,
  }),
  writeTool({
    name: 'reset_grid_trade',
    signature: `POST ${SYMBOL}/reset-grid-trade`,
    description: 'Discard the current grid cycle state without archiving it.',
    shape: symbolArgs,
  }),
  writeTool({
    name: 'reset_symbol_config',
    signature: `POST ${SYMBOL}/reset-config`,
    description: 'Drop this symbol per-symbol override so it inherits the profile configuration.',
    shape: symbolArgs,
  }),
  writeTool({
    name: 'disable_symbol',
    signature: `POST ${SYMBOL}/disable`,
    description: 'Stop trading this symbol for a while. Resting orders are left alone.',
    shape: {
      ...symbolArgs,
      ttlSeconds: z.number().int().positive().max(604800),
      reason: z
        .string()
        .min(1)
        .max(256)
        .describe('Why trading on this symbol is being stopped. Kept in the audit log.'),
    },
  }),
  writeTool({
    name: 'enable_symbol',
    signature: `DELETE ${SYMBOL}/disable`,
    description:
      'Resume trading a symbol that was switched off. This re-arms real trading on it, which is why it needs the same confirmation as any other write.',
    shape: symbolArgs,
  }),
  writeTool({
    name: 'disable_all_symbols',
    signature: `POST ${PROFILE}/disable-all`,
    description: 'Stop trading every symbol in this profile. Resting orders are left alone.',
    shape: profileArgs,
  }),
  writeTool({
    name: 'enable_all_symbols',
    signature: `DELETE ${PROFILE}/disable-all`,
    description: 'Resume trading every symbol in this profile. This re-arms real trading.',
    shape: profileArgs,
  }),
  writeTool({
    name: 'update_risk_config',
    signature: `PATCH ${PROFILE}/risk-config`,
    description:
      'Set the risk breakers. Widening a limit can lift a halt that is currently stopping this profile from trading: the worker re-reads these values every cycle, so a raised daily loss limit resumes trading on the next one. Fields you leave out keep their stored values, but a block you send replaces that whole block: sending drawdown with only maxDrawdownQuote resets its lookbackHours and pauseHours to their defaults. Read get_risk first and send every field of any block you change. Narrow deliberately, widen very deliberately.',
    shape: { ...profileArgs, ...riskConfigArgs },
  }),
  writeTool({
    name: 'update_discovery_config',
    signature: `PATCH ${PROFILE}/discovery-config`,
    description:
      'Set automatic symbol discovery: whether it runs, how often, the blocklist, the volume, spread and rank bounds, and how many symbols it may bind. Fields you leave out keep their stored values, but a field you send replaces its whole value: blacklist is the complete new list, not an addition, and a nested block such as entryGuard or trendConfirm is replaced whole. Read get_discovery first and send the full value of anything you change.',
    shape: { ...profileArgs, ...discoveryConfigArgs },
  }),
  writeTool({
    name: 'update_profile',
    signature: `PATCH ${PROFILE}`,
    description:
      'Change the profile, including its entire strategy configuration. The config you send is re-validated against the same schema list_strategies published, so an unknown field or a wrong type is rejected rather than half-applied. Read list_strategies first, and preview_config or lint_config before committing.',
    shape: {
      ...profileArgs,
      name: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    },
  }),
  writeTool({
    name: 'update_symbol_config',
    signature: `PATCH ${SYMBOL}`,
    description:
      'Set the per-symbol override for this symbol. It is merged over the profile configuration and the merged result is re-validated, so an override that is valid alone can still be rejected in combination.',
    shape: { ...symbolArgs, overrideConfig: z.record(z.string(), z.unknown()) },
  }),
  writeTool({
    name: 'create_profile',
    signature: `POST ${ACCOUNTS}/profiles`,
    description:
      'Create a new strategy profile on this account. It shares the account wallet with every other profile. Not retry-safe: calling this twice creates two profiles, and deleting one is not something you can do here, only the operator can. If a call times out, read list_profiles back before trying again. The duplicate is created stopped, so it will not trade until start_profile.',
    shape: {
      ...accountArg,
      name: z.string().min(1),
      strategyName: z.string().min(1),
      strategyVersion: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
    },
  }),
  writeTool({
    name: 'start_profile',
    signature: `POST ${PROFILE}/start`,
    description: 'Start this profile trading.',
    shape: profileArgs,
  }),
  writeTool({
    name: 'stop_profile',
    signature: `POST ${PROFILE}/stop`,
    description:
      'Stop this profile from opening or managing positions. It does NOT cancel resting orders, which stay live on Binance and can still fill. Do not report a position as closed on the strength of this call.',
    shape: profileArgs,
  }),
  writeTool({
    name: 'switch_strategy',
    signature: `POST ${PROFILE}/switch-strategy`,
    description:
      'Replace the strategy plugin this profile runs, with a fresh configuration. config is required and is the whole configuration for the new strategy, not a patch; list_strategies returns each strategy with its default configuration to start from.',
    shape: {
      ...profileArgs,
      strategyName: z.string().min(1),
      strategyVersion: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
    },
  }),
  writeTool({
    name: 'add_symbol',
    signature: `POST ${PROFILE}/symbols`,
    description:
      'Bind a symbol to this profile so the strategy trades it. Optionally seed a known cost basis.',
    shape: {
      ...profileArgs,
      symbol: z.string().min(1),
      avgEntryPrice: z.string().optional(),
    },
  }),
  writeTool({
    name: 'remove_symbol',
    signature: `DELETE ${SYMBOL}`,
    description:
      'Unbind a symbol from this profile. This is a structural teardown, not a configuration edit: it detaches the symbol state and its orders. Any position in it is left on Binance untouched, so sell first if you meant to exit.',
    shape: symbolArgs,
  }),
  writeTool({
    name: 'adopt_orphan_order',
    signature: `POST ${ACCOUNTS}/orphan-orders/adopt`,
    description:
      'Take an order placed outside this bot under management. The profile it lands in is derived from the order itself and cannot be chosen. list_orphan_orders first: an order id is unique only within one Binance environment, so the id alone does not identify an order.',
    shape: {
      ...accountArg,
      orderId: z.string().min(1).describe('Binance order id, from list_orphan_orders.'),
      // The route takes the Binance ENVIRONMENT here, not a manner of adopting. Declared as the enum rather than a bare string because a free-text field named `mode` invites a guess at the second reading, and every such guess is refused by the route with a message the caller then has to decode.
      mode: z
        .enum(['test', 'live'])
        .describe('Binance environment the order lives on. Must match the account binanceMode.'),
    },
  }),
  writeTool({
    name: 'request_dust_transfer',
    signature: `POST ${PROFILE}/dust-transfer`,
    description:
      'Ask Binance to convert the listed dust balances to BNB. Binance offers this on live accounts only: on a testnet account the request is accepted and queued but never converts anything, and get_dust_eligible returns an empty list there for the same reason.',
    shape: { ...profileArgs, assets: z.array(z.string().min(1)).min(1) },
  }),
  writeTool({
    name: 'cancel_dust_transfer',
    signature: `DELETE ${PROFILE}/dust-transfer`,
    description: 'Withdraw a dust-conversion request that has not run yet.',
    shape: profileArgs,
  }),
  writeTool({
    name: 'reconcile_fees',
    signature: `POST ${PROFILE}/reconcile-fees`,
    description:
      'Re-pull trade fees from Binance to complete the fee record. Costs a large slice of the account request budget for this profile.',
    shape: profileArgs,
  }),
  writeTool({
    name: 'run_backtest',
    signature: `POST ${PROFILE}/backtests`,
    description:
      'Queue a backtest over a window of history. Compute-heavy and long-running; poll get_backtest for progress and use abort_backtest to stop it. The run is priced by fees, slippage and spread, so leaving those at zero backtests a market that does not exist.',
    // Spread from the route's own request schema rather than restated, because a backtest request is a dozen required fields and a restatement of it here is a second copy that starts agreeing and stops silently. It also replaces an opaque `params` object the caller had no description of: the fields now carry the contract's own constraints, which is what the caller needs to fill them in.
    shape: { ...profileArgs, ...BacktestParamsSchema.shape },
  }),
  writeTool({
    name: 'abort_backtest',
    signature: `POST ${PROFILE}/backtests/:runId/abort`,
    description: 'Stop a running backtest.',
    shape: { ...profileArgs, runId: z.string().min(1) },
  }),
  writeTool({
    name: 'run_backtest_advisor',
    signature: `POST ${PROFILE}/backtests/:runId/advisor/:variant`,
    description:
      'Ask the configured AI provider to suggest configuration changes from a backtest. This SPENDS the operator third-party AI credits on every call, and there is no free tier behind it.',
    shape: {
      ...profileArgs,
      runId: z.string().min(1),
      variant: z
        .enum(['safe', 'ride-trend', 'trade-more', 'aggressive', 'defensive'])
        .describe('Which advisory stance to generate. Each is a separate paid call.'),
    },
  }),
  writeTool({
    name: 'start_diagnosis_run',
    signature: `POST ${PROFILE}/diagnosis/runs`,
    description:
      'Start a profile diagnosis. With liveProbe set it queries Binance, which spends request budget.',
    shape: { ...profileArgs, liveProbe: z.boolean().optional() },
  }),
];

/**
 * Routes that must never acquire a tool. A tool pointing at one of these is a bug, and the topology test computes that from these two constants rather than from a hand-kept list.
 *
 * The reasoning, grouped:
 *
 * - Backup and restore. `GET /api/backup` streams a full database dump, and this deployment stores Binance keys and notifier secrets in plaintext by design, so one call would put the operator credentials into a chat transcript. `POST /api/restore` is a destructive whole-database overwrite.
 * - Account mutation and credential writes, which the operator excluded outright.
 * - `POST /api/account/ai-provider/test`, excluded on its own merit: its `baseUrl` is a deliberately unrestricted outbound request, which is acceptable for a human at a keyboard and not for a model that reads untrusted market commentary.
 * - Profile delete and trade-archive delete, which the operator excluded. Profile delete detaches orders; archive delete destroys the evidence an incident review runs on.
 * - Notifier writes and every auth route, which are secret-bearing and identity-bearing respectively.
 */
export const NO_TOOL_DENIED: readonly string[] = [
  'GET /api/backup',
  'PUT /api/backup/config',
  'POST /api/restore',
  'POST /api/accounts',
  'PATCH /api/accounts/:accountId',
  'DELETE /api/accounts/:accountId',
  'PUT /api/accounts/:accountId/api-key',
  'DELETE /api/accounts/:accountId/api-key',
  'PATCH /api/account/ai-provider',
  'POST /api/account/ai-provider/test',
  'PATCH /api/retention-config',
  `DELETE ${PROFILE}`,
  `DELETE ${PROFILE}/trade-archive/:archiveId`,
  `POST ${PROFILE}/notify-providers/:name`,
  `POST ${PROFILE}/notify-providers/:name/test-fire`,
  `PATCH ${PROFILE}/notify-providers/:name/enabled`,
  'GET /api/auth/onboarding-status',
  'GET /api/auth/session',
  'POST /api/auth/change-password',
  'POST /api/auth/sign-up',
  'POST /api/auth/sign-in/email',
  'POST /api/auth/sign-out',
  'POST /api/auth/single-sign-on/start',
  'POST /api/auth/single-sign-on/link',
  'POST /api/auth/single-sign-on/unlink',
  'POST /api/auth/password',
  'GET /api/auth/sessions',
  'POST /api/auth/sessions/:sessionId/revoke',
  'POST /api/auth/sessions/revoke-others',
  'POST /api/auth/sign-out-everywhere',
  'POST /api/auth/agent-access/revoke',
  'GET /api/auth/security-settings',
  'PATCH /api/auth/security-settings',
  'GET /api/auth/security-events',
];

/**
 * Routes that are safe but not worth a tool definition, listed explicitly so the partition is total and so nobody later has to guess whether an omission was a security decision or an oversight. Promoting one is a one-line move into `MCP_TOOLS`.
 *
 * Exports duplicate a read the agent already has in JSON. Pin and unpin are display-only. The remaining entries are operator-console surfaces an agent has no use for, or reads whose content is already reachable through a surfaced tool.
 */
export const NO_TOOL_NOT_SURFACED: readonly string[] = [
  'GET /api/account/ai-provider',
  'GET /api/account/ops-notify',
  'PATCH /api/account/ops-notify',
  'GET /api/account/settings',
  'PATCH /api/account/settings',
  'GET /api/backup/config',
  'GET /api/retention-config',
  'GET /api/retention-status',
  'GET /api/technicals/health',
  'GET /api/worker/crons',
  `GET ${ACCOUNTS}/dashboard-aggregate`,
  `GET ${PROFILE}/action-logs`,
  `GET ${PROFILE}/audit-logs/export`,
  `GET ${PROFILE}/backtests/:runId/advisor/manual/prompt`,
  `POST ${PROFILE}/backtests/:runId/advisor/manual`,
  `DELETE ${PROFILE}/backtests/:runId`,
  `POST ${PROFILE}/backtests/:runId/retry`,
  `GET ${PROFILE}/discovery-scoreboard`,
  `GET ${PROFILE}/dust-transfer/history`,
  `GET ${PROFILE}/logs/export`,
  `GET ${PROFILE}/logs/symbols`,
  `GET ${PROFILE}/notify-providers`,
  `GET ${PROFILE}/notify-providers/:name`,
  `GET ${PROFILE}/trade-archive/:archiveId`,
  `GET ${PROFILE}/trade-archive/export`,
  `GET ${SYMBOL}/archive`,
  `POST ${SYMBOL}/pin`,
  `POST ${SYMBOL}/unpin`,
  `POST ${SYMBOL}/trade-archive-backfill`,
  `POST ${SYMBOL}/unreconstructable-dismiss`,
];

/** Index for dispatch. Built once; a duplicate name would silently shadow, so the tool count is asserted against it. */
export const MCP_TOOLS_BY_NAME: ReadonlyMap<string, McpTool> = new Map(
  MCP_TOOLS.map((tool) => [tool.name, tool]),
);
