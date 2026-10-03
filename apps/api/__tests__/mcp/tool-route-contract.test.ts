import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { DI } from '../../src/di.js';
import { MCP_TOOLS } from '../../src/mcp/tools.js';
import { mountApiRouters } from '../../src/routes/mount.js';
import { createApiHono } from '../../src/types.js';

/**
 * Every tool argument has to be an argument its route actually takes.
 *
 * This is the one defect class that kept recurring while the tool table was being written, in four separate places and never the same way twice: a tool declaring `side` in the wrong case, a period format the route spells differently, a `limit` three of four routes silently threw away, and a free-text `mode` where the route wanted an environment. Each read as a well-formed call and each was refused, or worse, quietly answered with something other than what was asked for.
 *
 * A reviewer cannot catch these by reading, because the two halves live in different files and only ever meet at runtime. The route contracts are already published as JSON Schema in the OpenAPI document, so the comparison can be made structurally, once, over every tool.
 *
 * Two properties are checked. A declared argument must be ACCEPTED somewhere by the tool's route: as a path parameter, a query parameter on a read, or a request-body property on a write. And where the route constrains an argument to a fixed set, the tool must constrain it to a subset of that same set, which is what stops one side spelling an enum in a case or a format the other rejects.
 */

interface JsonSchemaNode {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly additionalProperties?: unknown;
}

interface Operation {
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: string;
    readonly schema?: JsonSchemaNode;
  }[];
  readonly requestBody?: {
    readonly content?: Readonly<Record<string, { readonly schema?: JsonSchemaNode }>>;
  };
}

type PathItem = Readonly<Record<string, Operation>>;

const openApiDocument = (): Readonly<Record<string, PathItem>> => {
  const app = createApiHono();
  mountApiRouters(app, {} as DI);
  const doc = app.getOpenAPIDocument({
    openapi: '3.1.0',
    info: { title: 'contract-cross-check', version: '0' },
  }) as unknown as { paths: Record<string, PathItem> };
  return doc.paths;
};

/** The tool table spells path parameters `:name`; the document spells them `{name}`. */
const toDocumentPath = (template: string): string =>
  template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');

const pathParamsOf = (template: string): Set<string> =>
  new Set([...template.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1] as string));

/**
 * Where one route will accept each named argument, and with what fixed set if any.
 *
 * @param op - The route's OpenAPI operation.
 * @returns Accepted argument names, and the enum each one is restricted to when the route restricts it.
 */
const acceptedArgs = (op: Operation): Map<string, readonly unknown[] | null> => {
  const accepted = new Map<string, readonly unknown[] | null>();
  for (const parameter of op.parameters ?? []) {
    if (parameter.in === 'query' || parameter.in === 'path') {
      accepted.set(parameter.name, parameter.schema?.enum ?? null);
    }
  }
  const body = op.requestBody?.content?.['application/json']?.schema;
  for (const [name, node] of Object.entries(body?.properties ?? {})) {
    accepted.set(name, node.enum ?? null);
  }
  return accepted;
};

/** Zod exposes an enum's members differently across wrappers; reading `.options` off the unwrapped schema covers the optional and defaulted forms the tool table uses. */
const enumOptionsOf = (schema: z.ZodType): readonly unknown[] | null => {
  let current: unknown = schema;
  for (let depth = 0; depth < 5; depth += 1) {
    const options = (current as { options?: readonly unknown[] }).options;
    if (Array.isArray(options)) return options;
    const inner = (current as { unwrap?: () => unknown }).unwrap;
    if (typeof inner !== 'function') return null;
    current = inner.call(current);
  }
  return null;
};

/** Consumed by the dispatcher before the request is built, so neither ever reaches a route. */
const DISPATCHER_ARGS: ReadonlySet<string> = new Set(['idempotencyKey', 'kind']);

describe('every MCP tool argument is one its route accepts', () => {
  const paths = openApiDocument();

  const operationsFor = (tool: (typeof MCP_TOOLS)[number]): Operation[] =>
    tool.routes.map((signature) => {
      const boundary = signature.indexOf(' ');
      const method = signature.slice(0, boundary).toLowerCase();
      const template = toDocumentPath(signature.slice(boundary + 1));
      const item = paths[template];
      if (!item) throw new Error(`${tool.name}: no route documented at ${template}`);
      const op = item[method];
      if (!op) throw new Error(`${tool.name}: ${template} documents no ${method}`);
      return op;
    });

  it('documents every route the tool table dispatches to', () => {
    // A signature that matches no mounted route can never be called, and the partition test cannot see it: that test compares signature strings against each other, so a typo shared by both sides passes it.
    expect(() => MCP_TOOLS.map(operationsFor)).not.toThrow();
  });

  it('declares no argument its route would ignore', () => {
    const orphans: string[] = [];
    for (const tool of MCP_TOOLS) {
      const ops = operationsFor(tool);
      // A consolidated read reaches several routes on purpose, and an argument that belongs to one kind is not an argument the others have to take. One accepting route is therefore enough.
      const accepted = new Set(
        tool.routes.flatMap((signature, index) => [
          ...pathParamsOf(signature.slice(signature.indexOf(' ') + 1)),
          ...acceptedArgs(ops[index] as Operation).keys(),
        ]),
      );
      for (const name of Object.keys(tool.inputShape)) {
        if (DISPATCHER_ARGS.has(name)) continue;
        if (!accepted.has(name)) orphans.push(`${tool.name}.${name}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('sends only the settings the caller named, on a route that replaces the whole object', () => {
    // Both stored-config routes write their parsed body to the column verbatim, so a field the tool materialises from a default is a field the caller never chose and is about to overwrite. Risk is the case that matters: adjusting the daily loss limit must not carry a default loss-streak and drawdown guard along with it, because those are breakers, and a breaker reset to its default can be wider than the one it replaced.
    const tool = MCP_TOOLS.find((entry) => entry.name === 'update_risk_config');
    if (!tool) throw new Error('update_risk_config is not in the tool table');
    const parsed = tool.inputSchema.parse({
      accountId: 'a',
      profileId: 'p',
      dailyLossLimitQuote: '5',
    });
    expect(Object.keys(parsed as Record<string, unknown>).sort()).toEqual([
      'accountId',
      'dailyLossLimitQuote',
      'profileId',
    ]);
  });

  it('spells every fixed-set argument the way its route spells it', () => {
    const mismatches: string[] = [];
    // Which arguments this sweep actually compared. The loop skips any route node without an inline `enum`, and today every contract uses a bare `z.enum(...)`, which zod-openapi inlines. One `.openapi({ ref: '...' })` on a shared enum turns those nodes into `$ref`s carrying no `enum`, every iteration takes the skip, and the sweep reports green having compared nothing. A count alone would not be enough either, so the compared set is pinned against the set the tool table declares below.
    const compared = new Set<string>();
    for (const tool of MCP_TOOLS) {
      const ops = operationsFor(tool);
      ops.forEach((op, index) => {
        for (const [name, routeEnum] of acceptedArgs(op)) {
          if (routeEnum === null) continue;
          const declared = tool.inputShape[name];
          if (declared === undefined) continue;
          compared.add(`${tool.name}.${name}`);
          const toolEnum = enumOptionsOf(declared);
          if (toolEnum === null) {
            mismatches.push(
              `${tool.name}.${name} is unconstrained, but ${tool.routes[index]} accepts only ${routeEnum.join('|')}`,
            );
            continue;
          }
          const extra = toolEnum.filter((option) => !routeEnum.includes(option));
          if (extra.length > 0) {
            mismatches.push(
              `${tool.name}.${name} offers ${extra.join('|')}, which ${tool.routes[index]} refuses`,
            );
          }
        }
      });
    }
    expect(mismatches).toEqual([]);

    // Derived from the tool table rather than written down as a number, so adding a tool moves both sides together and only a SHRUNKEN walk fails. Equality rather than a floor is deliberate: an argument the tool constrains to a fixed set while its route leaves it open was compared against nothing, which is precisely the blind spot this file exists to close, so it has to surface here rather than be counted as covered.
    const declared = new Set<string>();
    for (const tool of MCP_TOOLS) {
      for (const [name, schema] of Object.entries(tool.inputShape)) {
        if (DISPATCHER_ARGS.has(name)) continue;
        if (enumOptionsOf(schema) !== null) declared.add(`${tool.name}.${name}`);
      }
    }
    expect(declared.size).toBeGreaterThan(0);
    expect([...compared].sort()).toEqual([...declared].sort());
  });
});
