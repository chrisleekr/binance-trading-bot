// An agent action leaves exactly one trace: the `audit_logs` row the audit middleware writes when a handler declares an `auditEvent`. A handler that declares none returns 200 and writes nothing, so the action is invisible under every actor, agent and operator alike.
//
// The check is over the whole tool table rather than over named routes. Two un-audited write routes were found by reading handlers one at a time, which is exactly the method that misses the third: the set has to come from `MCP_TOOLS` so a write tool added later either audits or fails here.

import { describe, expect, it } from 'vitest';
import type { DI } from '../../src/di.js';
import { MCP_SCOPE_TRADE } from '../../src/mcp/scopes.js';
import { MCP_TOOLS } from '../../src/mcp/tools.js';
import { mountApiRouters } from '../../src/routes/mount.js';
import { createApiHono } from '../../src/types.js';

/**
 * Non-GET endpoints that persist nothing and therefore have nothing to record. Each is reachable only through a read-scope tool, which the suite re-derives below rather than trusting this comment: the exemption is the scope decision in the tool table, not a second opinion about it.
 */
const NON_PERSISTING_ROUTES: readonly string[] = [
  // Projects the levels a candidate configuration would place. Reads prices and filters, writes nothing.
  'POST /api/accounts/:accountId/profiles/:profileId/symbols/:symbol/preview-config',
  // Runs the strategy's own linter over a candidate configuration and returns diagnostics.
  'POST /api/accounts/:accountId/profiles/:profileId/lint-config',
  'POST /api/strategies/:name/lint-config',
];

/** The call the audit middleware reads. Matched as the call rather than the bare identifier so a mention in a comment or a dead binding cannot stand in for the declaration. */
const AUDIT_CALL = /\.set\(\s*['"]auditEvent['"]/;

/**
 * Every route signature registered by the real router set, mapped to whether some handler at that signature declares an audit event.
 *
 * Hono records the middleware chain and the terminal handler as separate entries under one method and path, so the question is whether ANY entry there declares one: the validators registered ahead of an `openapi()` handler never will.
 *
 * @returns Signature to audit-declaring flag, over the mounted route table.
 */
const auditDeclarations = (): ReadonlyMap<string, boolean> => {
  const app = createApiHono();
  mountApiRouters(app, {} as DI);
  const declared = new Map<string, boolean>();
  for (const route of app.routes) {
    const signature = `${route.method} ${route.path}`;
    const already = declared.get(signature) ?? false;
    declared.set(signature, already || AUDIT_CALL.test(String(route.handler)));
  }
  return declared;
};

interface ToolEntry {
  readonly name: string;
  readonly scope: string;
  readonly routes: readonly string[];
}

const tools: readonly ToolEntry[] = MCP_TOOLS;

/** Tool name paired with each non-GET route it dispatches to, flattened, because a consolidated tool can carry several. */
const nonGetPairs = (entries: readonly ToolEntry[]): readonly (readonly [string, string])[] =>
  entries.flatMap((tool) =>
    tool.routes.filter((r) => !r.startsWith('GET ')).map((r) => [tool.name, r] as const),
  );

describe('every mutating MCP tool writes an audit row', () => {
  const declared = auditDeclarations();
  const pairs = nonGetPairs(tools);

  it('enumerates a non-trivial set of non-GET tool routes', () => {
    // A derivation that silently returned nothing would make every assertion below hold for want of anything to check. The floor is well under the current count so a deliberate tool removal does not fail it, but an empty or collapsed derivation does.
    expect(pairs.length).toBeGreaterThan(20);
    expect(tools.some((tool) => tool.scope === MCP_SCOPE_TRADE)).toBe(true);
  });

  it('routes every non-GET tool call at a handler that declares an audit event', () => {
    const unaudited = pairs
      .filter(([, route]) => !NON_PERSISTING_ROUTES.includes(route))
      .filter(([, route]) => declared.get(route) !== true)
      .map(([name, route]) => `${name} -> ${route}`)
      .sort();
    expect(unaudited).toEqual([]);
  });

  it('registers every non-GET tool route on the mounted app', () => {
    // Guards the assertion above against its own escape hatch: a signature that matches no mounted route reads as `undefined` rather than `false`, and a typo in the tool table would otherwise decide nothing.
    const unmounted = pairs
      .filter(([, route]) => !declared.has(route))
      .map(([name, route]) => `${name} -> ${route}`)
      .sort();
    expect(unmounted).toEqual([]);
  });

  it('exempts a non-persisting route only where no trade-scope tool reaches it', () => {
    // The exemption is only ever safe because these routes persist nothing, and the tool table says so by granting them read scope. A write tool pointed at one would make this fail rather than inherit the exemption.
    const reachedByTrade = tools
      .filter((tool) => tool.scope === MCP_SCOPE_TRADE)
      .flatMap((tool) =>
        tool.routes
          .filter((route) => NON_PERSISTING_ROUTES.includes(route))
          .map((r) => `${tool.name} -> ${r}`),
      )
      .sort();
    expect(reachedByTrade).toEqual([]);
  });

  it('keeps the exemption list free of entries no tool dispatches to', () => {
    // A stale entry is how an exemption outlives its justification: the route is renamed or dropped, the line stays, and it silently covers whatever later takes that signature.
    const reachable = new Set(pairs.map(([, route]) => route));
    expect(NON_PERSISTING_ROUTES.filter((route) => !reachable.has(route))).toEqual([]);
  });
});
