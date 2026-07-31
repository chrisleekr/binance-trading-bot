import { ProfileResponse, type SwitchStrategyRequest } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * POST /profiles/:id/switch-strategy. The route resets state to the new
 * strategy's `initialState(config)` and auto-pauses; the SPA refetches the
 * profile dashboard after success so the paused banner appears.
 */
export const switchStrategy = (
  profileId: string,
  body: SwitchStrategyRequest,
): Promise<ProfileResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/switch-strategy`), ProfileResponse, {
    method: 'POST',
    body,
  });
