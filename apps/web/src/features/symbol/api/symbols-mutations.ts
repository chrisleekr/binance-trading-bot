import { ProfileSymbolResponse, type SymbolCreate } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * Add a single trading-pair to a profile. The wizard's optional Step 5
 * loops over user-entered symbols and posts each one. Keeping the contract
 * one-symbol-per-call mirrors the per-symbol error-reporting the operator
 * needs (a typo on `BTCUSDT` shouldn't reject the whole batch).
 */
export const addProfileSymbol = (
  profileId: string,
  body: SymbolCreate,
): Promise<ProfileSymbolResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/symbols`), ProfileSymbolResponse, {
    method: 'POST',
    body,
  });
