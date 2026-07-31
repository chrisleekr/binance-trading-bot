import { z } from 'zod';

/** Acknowledgement that a restore completed; only the timestamp is meaningful for the operator UI. */
export const RestoreResponse = z.object({
  restoredAt: z.iso.datetime(),
});
/** TS type derived from {@link RestoreResponse} so consumers don't re-run z.infer at every call site. */
export type RestoreResponse = z.infer<typeof RestoreResponse>;
