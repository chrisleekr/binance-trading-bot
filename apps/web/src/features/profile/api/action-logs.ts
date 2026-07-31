import { ActionLogErrorsResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * Recent warn+error action-log rows for a profile, feeding the dashboard
 * activity feed's Errors chip. Limit is the backend default; the client
 * doesn't pass it so a tweak in the API needs no coordinated frontend bump.
 */
export const fetchProfileActionErrors = (profileId: string): Promise<ActionLogErrorsResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/action-logs`), ActionLogErrorsResponse, {
    method: 'GET',
  });
