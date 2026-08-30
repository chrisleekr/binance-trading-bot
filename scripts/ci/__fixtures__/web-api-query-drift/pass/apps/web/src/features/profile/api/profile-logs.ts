import { apiDownloadUrl } from '../../../shared/lib/api';

export const download = (levels?: string, symbols?: string): string =>
  apiDownloadUrl('/accounts/{accountId}/profiles/{profileId}/logs/export', {
    levels,
    symbols,
  });
