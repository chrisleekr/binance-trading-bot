import { AccountHealthResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** Query key for the always-visible account-health poll. */
export const accountHealthQueryKey = (): readonly unknown[] => ['account-health'];

/**
 * GET /account/health. The "is my money OK right now" snapshot: worker
 * liveness, active halts, today's realized P/L per quote, and any profile
 * approaching its daily-loss limit. Polled by the persistent header bar.
 */
export const fetchAccountHealth = (): Promise<AccountHealthResponse> =>
  apiFetch(accountPath('/account/health'), AccountHealthResponse, { method: 'GET' });
