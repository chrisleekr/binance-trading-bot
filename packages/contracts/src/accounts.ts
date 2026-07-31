import { z } from 'zod';
import { BinanceMode } from './profiles.js';

/**
 * A Binance account: one API key pair plus the environment that key pair talks
 * to. N strategy profiles hang off one account and share its real balance (one
 * Binance account is one balance pot). The operator owns N accounts under a
 * single login; the account is always named explicitly in the request URL.
 */

/** Account display name. Same charset as a profile name so the two switchers read alike. */
export const AccountName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9 _-]+$/,
    'Account name can only contain letters, numbers, spaces, dashes, and underscores.',
  );

/**
 * Body for `POST /accounts`. `binanceMode` is fixed at create: it is the
 * environment the key pair talks to (testnet keys vs live keys), and a key pair
 * cannot switch environments, so it is not patchable afterwards.
 */
export const AccountCreate = z.object({
  name: AccountName,
  binanceMode: BinanceMode,
});
/** TS type derived from {@link AccountCreate} so consumers don't re-run z.infer at every call site. */
export type AccountCreate = z.infer<typeof AccountCreate>;

/** Partial update for `PATCH /accounts/:accountId`. Only the display name is mutable. */
export const AccountPatch = z.object({
  name: AccountName.optional(),
});
/** TS type derived from {@link AccountPatch} so consumers don't re-run z.infer at every call site. */
export type AccountPatch = z.infer<typeof AccountPatch>;

/** Response shape for `GET /accounts/:accountId` (and each element of the list). */
export const AccountResponse = z.object({
  id: z.uuid(),
  name: z.string(),
  binanceMode: BinanceMode,
  /** Whether an API key pair has been stored for this account yet (drives the "add keys" prompt). */
  apiKeyConfigured: z.boolean(),
  createdAt: z.iso.datetime(),
});
/** TS type derived from {@link AccountResponse} so consumers don't re-run z.infer at every call site. */
export type AccountResponse = z.infer<typeof AccountResponse>;

/** Response shape for `GET /accounts`. Plain array; the list is small (single operator). */
export const AccountList = z.array(AccountResponse);
/** TS type derived from {@link AccountList} so consumers don't re-run z.infer at every call site. */
export type AccountList = z.infer<typeof AccountList>;
