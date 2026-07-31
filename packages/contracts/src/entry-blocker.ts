import { z } from 'zod';

/**
 * Structured "why is this symbol not buying right now" record, read from the
 * persisted strategy state. `null` when a buy was placed last tick or nothing
 * is blocking. Strategy-agnostic: `reason` is a free-text code (each strategy
 * owns its vocabulary) and `detail` carries sparse explaining values the web
 * gloss fills into a plain-language sentence. Numbers that are prices or
 * quantities arrive as decimal-strings inside `detail`. Shared by the symbol-state
 * response and the discovery-candidate row so the gloss map has one source.
 */
export const EntryBlockerResponse = z
  .object({
    reason: z.string(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .nullable();
/** TS type derived from {@link EntryBlockerResponse} so consumers don't re-run z.infer at every call site. */
export type EntryBlockerResponse = z.infer<typeof EntryBlockerResponse>;
