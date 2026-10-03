import { type AccountId, type AgentActionNotifyJob, type UserId } from '@app/contracts';
import { repo } from '@app/db';
import type { DI } from '../di.js';
import {
  claimIdempotencyKey,
  idempotencyFingerprint,
  idempotencyKeyFor,
  markIdempotencyAmbiguous,
  recordIdempotentOutcome,
  releaseIdempotencyKey,
  type IdempotencyRedis,
} from './idempotency.js';
import { createMcpInnerApp } from './inner-app.js';
import { MCP_SCOPE_TRADE } from './scopes.js';
import { MCP_TOOLS, MCP_TOOLS_BY_NAME, type McpRequestPlan, type McpTool } from './tools.js';

export interface McpToolResult {
  readonly isError: boolean;
  readonly text: string;
}

/**
 * Tools that reach Binance's order book. A retry of one of these is a second real order rather than a second read, so each carries an idempotency key.
 *
 * Derived from the table rather than written out again. A second list here would keep agreeing with the first right up to the day a sixth order-placing tool is added to one and not the other, which is the one moment this has to be right. Exported because the suite that pins the idempotency requirement sweeps this exact set.
 */
export const ORDER_PLACING_TOOLS: ReadonlySet<string> = new Set(
  MCP_TOOLS.filter((tool) => tool.placesOrder).map((tool) => tool.name),
);

const errorResult = (message: string): McpToolResult => ({ isError: true, text: message });

/**
 * Builds the header set the in-process request carries.
 *
 * A header is set only when the agent's request actually carried it, because `clientIp` distinguishes a missing forwarding header from an empty one and an empty string would be read as a hop.
 *
 * @param ctx - The calling agent's forwarded network identity.
 * @returns Headers for the synthesized request, always including the JSON content type the routers validate against.
 */
const innerHeaders = (ctx: McpClientContext): Record<string, string> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ctx.forwardedFor !== null && ctx.forwardedFor !== '')
    headers['x-forwarded-for'] = ctx.forwardedFor;
  if (ctx.realIp !== null && ctx.realIp !== '') headers['x-real-ip'] = ctx.realIp;
  if (ctx.userAgent !== null && ctx.userAgent !== '') headers['user-agent'] = ctx.userAgent;
  return headers;
};

/**
 * Reads the account id out of a tool's arguments, when it has one.
 *
 * @param args - Validated tool arguments.
 * @returns The account id, or null for an operator-global tool such as `list_accounts`.
 */
const accountIdOf = (args: Readonly<Record<string, unknown>>): AccountId | null => {
  const raw = args['accountId'];
  return typeof raw === 'string' && raw !== '' ? (raw as AccountId) : null;
};

/**
 * How a failed dispatch must settle its dedup key, decided from the status alone.
 *
 * A 4xx from an order route is a guard declining ahead of every write. Ownership, strategy support, the entry halt and argument validation all answer before the override row exists and before any tick is enqueued, so nothing was armed and the key is free to reuse. A 5xx is the opposite reading: the failure that reaches it is an enqueue whose rollback did not take, and the error type raised there exists precisely to say the override may still be live and may still execute.
 *
 * Named and exported rather than written inline because this one comparison decides whether a retry can become a second real order, and a rule that important should be nameable in a test.
 *
 * The 4xx half holds only while no order route answers 4xx after taking effect. The repo already has a name for that case, `alreadyApplied` on the audit event, and no order route sets it; `idempotency-settlement.test.ts` fails if one ever does, because a comment here would not.
 *
 * @param status - HTTP status the dispatched route answered with.
 * @returns `release` when the call provably armed nothing, `ambiguous` when it may have.
 */
export const settlementForStatus = (status: number): 'release' | 'ambiguous' =>
  status < 500 ? 'release' : 'ambiguous';

/**
 * The agent's own HTTP identity, carried from the MCP request into the in-process router set.
 *
 * The inner app is reached through a `Request` this process builds rather than one that arrived on a socket, so anything the routers read off headers is absent unless it is put back deliberately. Two audit columns depend on exactly that: `clientIp` derives the address from the forwarding headers, and the audit row stores the user agent verbatim. Without these an agent's row records the address as the literal `unknown` and the agent as null, which is the weakest trail in the system sitting on its most exposed surface, since the MCP endpoint is reachable from anywhere while the browser is not.
 *
 * The forwarding headers are carried through unparsed so the rightmost-hop rule in `clientIp` stays the single place an address is derived, rather than being re-derived here and able to disagree. Only these three are forwarded: passing the outer headers wholesale would hand the inner router set the bearer token as well, and keeping that token out of the REST routers is the point of mounting them behind a separate identity.
 */
export interface McpClientContext {
  readonly forwardedFor: string | null;
  readonly realIp: string | null;
  readonly userAgent: string | null;
}

/** No request context available. Used by callers that dispatch outside an HTTP request, which is only ever a test. */
export const EMPTY_CLIENT_CONTEXT: McpClientContext = {
  forwardedFor: null,
  realIp: null,
  userAgent: null,
};

export interface McpDispatchDeps {
  readonly di: DI;
  readonly operatorId: UserId;
  /** Scopes the verified access token carries. A tool needing one the token lacks is refused before anything is dispatched. */
  readonly grantedScopes: ReadonlySet<string>;
  /** The calling agent's network identity, forwarded so the audit row can name it. Optional so a test may omit it. */
  readonly clientContext?: McpClientContext;
}

/**
 * Resolves the account's Binance environment so every account-scoped result can say which one it acted on.
 *
 * Testnet and live accounts live in the same tables and behind the same tool surface, so nothing else in a transcript distinguishes a harmless testnet order from one that spent real money. Echoing the mode makes a wrong-`accountId` call visible in the conversation rather than silent.
 *
 * @param di - Container supplying the database handle.
 * @param accountId - Account the tool acted on, or null for an operator-global tool.
 * @returns The mode string, `unknown` when the account is in play but its mode could not be established, or null only when there is no account in play.
 */
const resolveBinanceMode = async (di: DI, accountId: AccountId | null): Promise<string | null> => {
  if (accountId === null) return null;
  try {
    // An absent account row reads back as null rather than raising, so the two ways a mode goes unread have to collapse to the same answer here. Both reach the caller as an omitted field otherwise, and a missing field reads as "operator-global", which is the one thing an account-scoped call definitely is not.
    return (await repo.accounts.binanceModeById(di.db, accountId)) ?? 'unknown';
  } catch {
    // A mode we could not read is reported as unknown rather than omitted, for the same reason.
    return 'unknown';
  }
};

/**
 * Enqueues the operator notification for a completed agent write.
 *
 * The api has no way to send a notification itself. The only production dispatch chokepoint is the worker's `dispatchNotify`, which also owns the live-demo kill switch, so this hands the event to the worker as a registered pipeline job rather than growing a second path that would bypass both.
 *
 * @param deps - Dispatch context supplying the queue and logger.
 * @param tool - Tool that ran, named in the notification so the operator sees what happened.
 * @param accountId - Account acted on; the event is scoped to it so the fan-out reaches that account's notifiers rather than every tenant's.
 * @param args - Validated arguments, read only for the symbol when there is one.
 * @returns Nothing; a failed enqueue is logged and never fails an action that already happened.
 */
const notifyAgentAction = async (
  deps: McpDispatchDeps,
  tool: McpTool,
  accountId: AccountId | null,
  args: Readonly<Record<string, unknown>>,
): Promise<void> => {
  if (accountId === null) return;
  const symbol = typeof args['symbol'] === 'string' ? args['symbol'] : undefined;
  // Typed against the shared contract rather than assembled inline: the consumer is in another package, so this annotation is the only thing that makes a renamed field a compile error here instead of a dead-lettered job there.
  const job: AgentActionNotifyJob = {
    userId: deps.operatorId,
    accountId,
    tool: tool.name,
    summary: `An AI agent ran ${tool.name}${symbol ? ` on ${symbol}` : ''}.`,
    ...(symbol !== undefined ? { symbol } : {}),
  };
  try {
    await deps.di.queue.add('notify-agent-action', job);
  } catch (err) {
    deps.di.logger.warn({ err, tool: tool.name }, 'mcp_notify_enqueue_failed');
  }
};

/**
 * Writes a dedup-record settlement without letting a storage fault overwrite the answer the caller actually needs.
 *
 * Every settlement runs after the dispatch has already decided what happened, so a throw out of Redis here would replace a route's own error envelope, or a placed order's success, with a storage error. That inversion is the expensive one: an agent told its order failed retries it, and the retry is a second real order. The record is a retry aid, not the outcome, so a failed write is logged and the outcome stands. The cost is bounded by the key's own expiry, at worst one key sitting on a stale state until the window closes.
 *
 * @param deps - Dispatch context supplying the logger.
 * @param tool - Tool whose key is being settled, named in the log line so a recurring Redis fault is attributable.
 * @param settle - The settlement to attempt.
 * @returns Nothing; a failure is logged at warn and swallowed.
 */
const settleQuietly = async (
  deps: McpDispatchDeps,
  tool: string,
  settle: () => Promise<void>,
): Promise<void> => {
  try {
    await settle();
  } catch (err) {
    deps.di.logger.warn({ err, tool }, 'mcp_idempotency_settle_failed');
  }
};

/**
 * Runs one tool call end to end: scope check, argument validation and request planning, idempotency claim, dispatch through the real routers, notification, result.
 *
 * The order matters and is not interchangeable. Scope is checked first so a read-only token never reaches the dispatch path at all. Schema validation and `tool.plan` run next, because every refusal the caller can correct on its own must happen before the key is spent: a key claimed ahead of them would go on refusing the corrected retry for the rest of the window over a call that never reached a route. The idempotency key is claimed only after that, and still before anything is dispatched, so a retry cannot place a second order while the first is still in flight. Only then does the call reach the router set, and only a 2xx raises a notification, because announcing a refused order would teach the operator to ignore the alerts.
 *
 * @param deps - Container, resolved operator, and the token's granted scopes.
 * @param toolName - Name of the tool the client invoked.
 * @param rawArgs - Arguments as the client sent them, before validation.
 * @returns The tool result, with `isError` set for every refusal and every non-2xx from the dispatched route.
 */
export const dispatchMcpTool = async (
  deps: McpDispatchDeps,
  toolName: string,
  rawArgs: unknown,
): Promise<McpToolResult> => {
  const tool = MCP_TOOLS_BY_NAME.get(toolName);
  if (!tool) return errorResult(`unknown tool: ${toolName}`);

  if (!deps.grantedScopes.has(tool.scope)) {
    return errorResult(
      `insufficient_scope: ${tool.name} requires ${tool.scope}, which this token does not carry. Re-authorize requesting ${tool.scope}.`,
    );
  }

  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(
      `invalid arguments for ${tool.name}: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const args = parsed.data as Record<string, unknown>;

  // Built before the dedup key is claimed, because it is the last thing that can refuse this call on its arguments alone. `plan` rejects a path parameter that is not a single segment and an argument the selected kind's route does not read, and both are the caller's to correct. Claiming first would spend their key on a call that never reached a route, and the key would then go on refusing the corrected retry for the rest of the window.
  let plan: McpRequestPlan;
  try {
    plan = tool.plan(args);
  } catch (err) {
    return errorResult(
      `invalid arguments for ${tool.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const needsKey = ORDER_PLACING_TOOLS.has(tool.name);
  const suppliedKey = args['idempotencyKey'];
  // Unreachable while every tool in the set above declares the key as required, because the schema check just above refuses the call first. Kept because it is what guarantees the dedup key below is a real string rather than the literal "undefined" shared by every caller, and that guarantee must survive a schema someone later relaxes. The live enforcement is the schema, and that is where it is pinned.
  if (needsKey && (typeof suppliedKey !== 'string' || suppliedKey === '')) {
    return errorResult(
      `${tool.name} requires an idempotencyKey. Placing an order is not retry-safe: two calls without a key place two real orders.`,
    );
  }

  const redis = deps.di.redis.raw() as unknown as IdempotencyRedis;
  const dedupKey = needsKey
    ? idempotencyKeyFor(deps.operatorId, tool.name, String(suppliedKey))
    : null;
  if (dedupKey !== null) {
    const claim = await claimIdempotencyKey(redis, dedupKey, idempotencyFingerprint(args));
    // Each refusal names a different remedy because each describes a different situation. One shared sentence here would be wrong for most callers that read it: telling an agent whose argument was refused to "read back the order state" sends it looking for an order that was never placed.
    switch (claim.status) {
      case 'replay':
        return { isError: false, text: claim.recorded };
      case 'in-flight':
        return errorResult(
          `${tool.name} with this idempotencyKey is still running. Wait for it rather than retrying; retrying with the same key will not place a second order, and a new key would.`,
        );
      case 'ambiguous':
        return errorResult(
          `${tool.name} with this idempotencyKey already failed in a way that may still have placed an order. Read the order state back with list_orders before deciding anything. Do not reissue this call under a new key until you have.`,
        );
      case 'unknown':
        return errorResult(
          `${tool.name} cannot account for an earlier call with this idempotencyKey: its record expired while the call was still open, so whether an order was placed is no longer known. Read the order state back with list_orders before retrying.`,
        );
      case 'mismatch':
        return errorResult(
          `${tool.name} refused: this idempotencyKey was already used for a different request. Nothing was dispatched. Use a new idempotencyKey for a new order; reuse a key only to retry the exact same call.`,
        );
      case 'claimed':
        break;
    }
  }

  const accountId = accountIdOf(args);
  const query = new URLSearchParams(plan.query).toString();
  const url = `http://mcp.internal${plan.path}${query ? `?${query}` : ''}`;

  let response: Response;
  let bodyText: string;
  try {
    const app = createMcpInnerApp(deps.di, deps.operatorId);
    response = await app.fetch(
      new Request(url, {
        method: plan.method,
        headers: innerHeaders(deps.clientContext ?? EMPTY_CLIENT_CONTEXT),
        ...(plan.body !== null ? { body: JSON.stringify(plan.body) } : {}),
      }),
    );
    bodyText = await response.text();
  } catch (err) {
    // A throw out of the dispatch itself carries no status, so `settlementForStatus` has nothing to read and the conservative half of its rule is the only honest answer: the override row is written to Redis before the tick is enqueued, so a failure anywhere in here can still leave a live override a later tick will execute. Releasing the key would invite a retry that becomes a second real order.
    if (dedupKey !== null)
      await settleQuietly(deps, tool.name, () => markIdempotencyAmbiguous(redis, dedupKey));
    // Logged at error rather than warn because, unlike a route's own refusal, nothing else in the system recorded this: the audit middleware never ran, and the agent's transcript is the only other place it exists.
    deps.di.logger.error(
      { err, tool: tool.name, operatorId: deps.operatorId, accountId, scope: tool.scope },
      'mcp_tool_dispatch_threw',
    );
    return errorResult(
      dedupKey === null
        ? `${tool.name} failed before it could report an outcome. Whether it took effect is not known from this answer; read the current state back before retrying.`
        : `${tool.name} failed before it could report an outcome, so it may still have placed an order. Read the order state back with list_orders before deciding anything. Do not reissue this call under a new key until you have.`,
    );
  }

  if (!response.ok) {
    if (dedupKey !== null) {
      // Settled on every failing path, never left holding the in-flight sentinel: an unsettled key goes on refusing the corrected retry for the rest of the window over a call that never reached the exchange. See {@link settlementForStatus} for which way each status settles and why.
      const settlement =
        settlementForStatus(response.status) === 'release'
          ? () => releaseIdempotencyKey(redis, dedupKey)
          : () => markIdempotencyAmbiguous(redis, dedupKey);
      await settleQuietly(deps, tool.name, settlement);
    }
    // A refused agent order is otherwise invisible on this side of the wire. The audit middleware skips a 4xx by design, and no notification is raised because announcing refusals would teach the operator to ignore the alerts, so without this line the only record that an agent tried to trade and was turned away lives in the agent's own transcript.
    deps.di.logger.warn(
      {
        tool: tool.name,
        operatorId: deps.operatorId,
        accountId,
        status: response.status,
        scope: tool.scope,
      },
      'mcp_tool_refused',
    );
    // The route's own error envelope is surfaced verbatim. Folding a 409 into a success would let a "your override was already claimed" answer read as "cancelled", which is the opposite of what happened.
    return errorResult(`HTTP ${response.status} from ${tool.name}: ${bodyText}`);
  }

  const binanceMode = await resolveBinanceMode(deps.di, accountId);
  const payload = JSON.stringify({
    ...(binanceMode !== null ? { binanceMode } : {}),
    result: bodyText === '' ? null : safeJson(bodyText),
  });

  // Best-effort, because the order is already placed by the time this runs: failing the call over an unwritten record would report a successful order as a failure, and the retry that follows is the second order this record exists to prevent. An unwritten record leaves the key on its in-flight sentinel, which refuses that retry rather than duplicating it.
  if (dedupKey !== null)
    await settleQuietly(deps, tool.name, () => recordIdempotentOutcome(redis, dedupKey, payload));
  if (tool.scope === MCP_SCOPE_TRADE) await notifyAgentAction(deps, tool, accountId, args);

  return { isError: false, text: payload };
};

/** Routes return JSON, but a body that is not parseable is still worth handing back rather than discarding. */
const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
