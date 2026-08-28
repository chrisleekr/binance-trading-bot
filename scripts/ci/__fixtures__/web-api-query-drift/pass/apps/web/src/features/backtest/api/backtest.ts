import { apiFetch } from '../../../shared/lib/api';

export const create = (force: boolean): Promise<unknown> =>
  apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
    method: 'POST',
    query: { force: force ? true : undefined },
  });
