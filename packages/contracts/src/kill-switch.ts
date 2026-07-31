import { z } from 'zod';

/**
 * Body for `POST /symbols/:symbol/disable`. `ttlSeconds` is capped at 7 days
 * so a forgotten kill-switch can't silently outlast the operator's memory of
 * applying it; `reason` is required for the audit log.
 */
export const SymbolDisableRequest = z.object({
  ttlSeconds: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 24 * 7),
  reason: z.string().min(1).max(256),
});
/** TS type derived from {@link SymbolDisableRequest} so consumers don't re-run z.infer at every call site. */
export type SymbolDisableRequest = z.infer<typeof SymbolDisableRequest>;
