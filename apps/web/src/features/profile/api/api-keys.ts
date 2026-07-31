import { ApiKeyResponse, type ApiKeyPut } from '@app/contracts';

import { accountPath } from '@/shared/lib/account-scope';
import { ApiError, apiFetch } from '@/shared/lib/api';

// The API key pair belongs to the account (one key pair = one Binance account =
// one environment); every profile under the account shares it. So key
// management is account-scoped: no profileId, path relative to the active
// account.

/**
 * Read the redacted (last-4) record for the account's bound key. Returns `null`
 * on 404 because "no key bound" is a normal state rather than an error.
 */
export const fetchApiKey = async (): Promise<ApiKeyResponse | null> => {
  try {
    return await apiFetch(accountPath('/api-key'), ApiKeyResponse, { method: 'GET' });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
};

/**
 * Bind/replace the Binance API credentials for the account. PUT (not POST)
 * because at most one key pair exists per account; see
 * `packages/contracts/src/api-keys.ts` for the shape contract.
 */
export const putApiKey = (body: ApiKeyPut): Promise<ApiKeyResponse> =>
  apiFetch(accountPath('/api-key'), ApiKeyResponse, { method: 'PUT', body });

/**
 * Stable query key for the account's api-key record. Keyed by `accountId` so
 * switching accounts never shows the previous account's key from cache.
 */
export const apiKeyQueryKey = (accountId: string): readonly unknown[] => [
  'account',
  'api-key',
  accountId,
];
