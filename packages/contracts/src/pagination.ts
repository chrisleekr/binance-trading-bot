import { z } from 'zod';

/**
 * Shared cursor pagination query. Coerces `limit` from string for raw query
 * strings; cap of 500 prevents accidental fetch-everything reads against the
 * archive table.
 */
export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
});
/** TS type derived from {@link PaginationQuery} so consumers don't re-run z.infer at every call site. */
export type PaginationQuery = z.infer<typeof PaginationQuery>;
