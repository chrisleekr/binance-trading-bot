import {
  AccountList,
  AccountResponse,
  type AccountCreate,
  type AccountPatch,
} from '@app/contracts';
import { z } from 'zod';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';

// Accounts are operator-global: the list and create routes mount at `/api/accounts`
// (not under `/accounts/:accountId`), so these paths do NOT go through
// `accountPath`. Per-account get/patch/delete name the id in the path directly.

const fetchAccounts = (): Promise<AccountList> =>
  apiFetch('/accounts', AccountList, { method: 'GET' });

/** Cache key for the operator's account list; the switcher and route guards share it. */
export const accountsQueryKey = ['accounts'] as const;

export const accountsQueryOptions = {
  queryKey: accountsQueryKey,
  queryFn: fetchAccounts,
} as const;

export const createAccount = (body: AccountCreate): Promise<AccountResponse> =>
  apiFetch('/accounts', AccountResponse, { method: 'POST', body });

export const fetchAccount = (accountId: string): Promise<AccountResponse> =>
  apiFetch(`/accounts/${encodePathSegment(accountId)}`, AccountResponse, { method: 'GET' });

export const patchAccount = (accountId: string, body: AccountPatch): Promise<AccountResponse> =>
  apiFetch(`/accounts/${encodePathSegment(accountId)}`, AccountResponse, { method: 'PATCH', body });

const NoBody = z.unknown();

/**
 * Deletes the account (and its profiles, via the DB cascade). Returns 204, or 409
 * with the open-exposure counts when the account still has live orders or held
 * positions. There is no force: the cascade would abandon those orders on Binance,
 * still holding the operator's coins. Delete each profile first and choose what
 * happens to its orders.
 */
export const deleteAccount = (accountId: string): Promise<unknown> =>
  apiFetch(`/accounts/${encodePathSegment(accountId)}`, NoBody, { method: 'DELETE' });
