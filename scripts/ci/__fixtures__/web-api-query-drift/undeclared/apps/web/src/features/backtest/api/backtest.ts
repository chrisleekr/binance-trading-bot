import { apiFetch } from '../../../shared/lib/api';

export const create = (): Promise<unknown> =>
  apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
    method: 'POST',
    query: { unknownKey: true },
  });
