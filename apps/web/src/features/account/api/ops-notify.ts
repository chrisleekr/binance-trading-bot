import { OpsNotifyConfig } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

/** Query key for the account-global ops notification toggles. */
export const opsNotifyQueryKey = ['ops-notify'] as const;

/** GET /account/ops-notify — which account-level ops events send a notification. */
export const fetchOpsNotify = (): Promise<OpsNotifyConfig> =>
  apiFetch('/account/ops-notify', OpsNotifyConfig);

/** PATCH /account/ops-notify — replace the full ops toggle map. */
export const updateOpsNotify = (body: OpsNotifyConfig): Promise<OpsNotifyConfig> =>
  apiFetch('/account/ops-notify', OpsNotifyConfig, { method: 'PATCH', body });
