import { z } from 'zod';

/**
 * The `account-info` Redis key payload. The worker serialises the operator's
 * wallet balances to this shape under `buildAccountInfoKey`; the tick's
 * snapshot-loader and the api's manual-order sizing both read it back.
 * Routing the writer and both readers through one schema keeps the untyped
 * JSON blob from drifting — past shape bugs were a direct consequence of
 * hand-casting it at each call site.
 *
 * `balances` is keyed by asset; each entry carries the free and locked amounts
 * as decimal strings (money values cross the wire as strings end-to-end).
 */
export const AccountInfoSnapshot = z.object({
  balances: z.record(z.string(), z.object({ free: z.string(), locked: z.string() })),
});

/** TS type derived from {@link AccountInfoSnapshot} so consumers don't re-run z.infer. */
export type AccountInfoSnapshot = z.infer<typeof AccountInfoSnapshot>;
