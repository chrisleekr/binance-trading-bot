// What the registration loop hands the server.
//
// The topology suite proves the tool TABLE never names a denied route. This one proves the SERVER is handed exactly that table and nothing else, which is a different claim: a registration loop that skipped a filter, or a stray extra `registerTool`, would leave the table honest and the surface wrong.
//
// It is deliberately NOT the authority on what a client is offered. `protocol-boundary.test.ts` is, because it reads the listing a real `tools/list` serves and so also covers the codec between here and the wire. This file stays because it needs no Docker: without an infrastructure stack the protocol suite does not run at all, and this is what keeps the registration claim pinned in that lane.

import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { UserId } from '@app/contracts';
import type { DI } from '../../src/di.js';
import { MCP_RESOURCES } from '../../src/mcp/resources.js';
import { MCP_SCOPE_TRADE } from '../../src/mcp/scopes.js';
import { MCP_TOOLS, NO_TOOL_DENIED } from '../../src/mcp/tools.js';
import { buildMcpServer } from '../../src/routes/mcp.js';

const OPERATOR = '00000000-0000-4000-8000-00000000c001' as UserId;
const di = { logger: { warn: vi.fn() }, redis: { raw: () => ({}) } } as unknown as DI;

interface RegisteredTool {
  readonly name: string;
  readonly annotations: Record<string, unknown>;
  readonly meta: Record<string, unknown> | undefined;
  /** Whether the config named `_meta` at all, which `meta` alone cannot tell apart from an explicit `undefined`. A tool asking for no client behaviour must omit the key rather than declare an empty one. */
  readonly declaresMeta: boolean;
}

const registered = (): { tools: RegisteredTool[]; resources: string[] } => {
  const tools: RegisteredTool[] = [];
  const resources: string[] = [];
  const toolSpy = vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (
    this: McpServer,
    name: string,
    config: unknown,
  ) {
    const cfg = config as {
      annotations?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    };
    tools.push({
      name,
      annotations: cfg.annotations ?? {},
      meta: cfg._meta,
      declaresMeta: '_meta' in cfg,
    });
    return {} as never;
  });
  const resourceSpy = vi
    .spyOn(McpServer.prototype, 'registerResource')
    .mockImplementation(function (this: McpServer, name: string) {
      resources.push(name);
      return {} as never;
    });
  try {
    buildMcpServer(di, OPERATOR, new Set([MCP_SCOPE_TRADE]));
  } finally {
    toolSpy.mockRestore();
    resourceSpy.mockRestore();
  }
  return { tools, resources };
};

describe('MCP server registration', () => {
  it('registers exactly the tool table, by name', () => {
    const { tools } = registered();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
  });

  it('registers nothing whose route sits in the denied bucket', () => {
    // Computed from the constants rather than a hand-written inventory, so a route moved into the denied bucket is covered here the moment it moves.
    const { tools } = registered();
    const denied = new Set(NO_TOOL_DENIED);
    const offending = tools.filter((tool) =>
      (MCP_TOOLS.find((t) => t.name === tool.name)?.routes ?? []).some((route) =>
        denied.has(route),
      ),
    );
    expect(offending).toEqual([]);
    expect(NO_TOOL_DENIED.length).toBeGreaterThan(0);
  });

  it('carries each tool annotations and meta through to the registration, in their own fields', () => {
    // The hints are what a client reads to decide whether to prompt, and it reads them from two fields. A table that declares them and a registration that drops one, or folds the anthropic keys into `annotations` where the client ignores them, would look correct in the topology suite and still hand the model a one-tap approval on a real order.
    const { tools } = registered();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const tool of MCP_TOOLS) {
      expect(byName.get(tool.name)?.annotations).toEqual({ ...tool.annotations });
      expect(byName.get(tool.name)?.meta).toEqual(tool.meta);
      // A tool with nothing to ask for declares no `_meta`, rather than an empty object the client has to open to learn it is empty.
      expect(byName.get(tool.name)?.declaresMeta).toBe(tool.meta !== undefined);
    }
    const tradeNames = MCP_TOOLS.filter((t) => t.scope === MCP_SCOPE_TRADE).map((t) => t.name);
    expect(tradeNames.length).toBeGreaterThan(0);
    for (const name of tradeNames) {
      expect(byName.get(name)?.annotations['destructiveHint']).toBe(true);
      expect(byName.get(name)?.meta?.['anthropic/requiresUserInteraction']).toBe(true);
      expect(byName.get(name)?.annotations['anthropic/requiresUserInteraction']).toBeUndefined();
    }
  });

  it('registers exactly the documentation resources', () => {
    const { resources } = registered();
    expect(resources.sort()).toEqual(MCP_RESOURCES.map((r) => r.name).sort());
  });
});
