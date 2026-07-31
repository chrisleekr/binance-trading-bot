import { AccountSettingsResponse, type UpdateTimezoneRequest } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

const fetchAccountSettings = (): Promise<AccountSettingsResponse> =>
  apiFetch('/account/settings', AccountSettingsResponse);

/** Query key for the account display settings; one row per account, no params. */
export const accountSettingsQueryKey = ['account-settings'] as const;

export const accountSettingsQueryOptions = {
  queryKey: accountSettingsQueryKey,
  queryFn: fetchAccountSettings,
} as const;

/** Persist the operator's display timezone — `PATCH /account/settings`. */
export const updateTimezone = (body: UpdateTimezoneRequest): Promise<AccountSettingsResponse> =>
  apiFetch('/account/settings', AccountSettingsResponse, { method: 'PATCH', body });
