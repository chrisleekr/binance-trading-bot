import { ExchangeInfoResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

/**
 * Fetch the cached Binance exchangeInfo. Used by the symbols/new picker (and
 * any future symbol-aware screen). The backend caches for 5 minutes; the
 * frontend's `queryDefaults.exchangeInfo()` reuses the same staleTime so a
 * page refresh is the only thing that round-trips against the API.
 */
export const fetchExchangeInfo = (): Promise<ExchangeInfoResponse> =>
  apiFetch('/exchange-info', ExchangeInfoResponse, { method: 'GET' });
