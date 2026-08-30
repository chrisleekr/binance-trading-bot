import apiDefault, {
  apiFetch,
  apiFetch as request,
} from '../../../shared/lib/api';
import * as api from '../../../shared/lib/api';

const localRequest = apiFetch;
const opaqueQuery = { force: true };
const query = { unknownKey: true };
const computedKey = 'force';
const dynamicMethod: 'GET' | 'POST' = 'POST';
const dynamicPath = '/accounts/{accountId}/profiles/{profileId}/backtests';

void apiDefault;
void localRequest;
void Reflect.apply(apiFetch, undefined, [
  '/accounts/{accountId}/profiles/{profileId}/backtests',
  {},
  { method: 'POST', query: { force: true } },
]);
void apiFetch.call(
  undefined,
  '/accounts/{accountId}/profiles/{profileId}/backtests',
  {},
  { method: 'POST', query: { force: true } },
);
void request('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
  method: 'POST',
  query: { force: true },
});
void api.apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
  method: 'POST',
  query: { force: true },
});
void apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
  method: 'POST',
  query: opaqueQuery,
});
void apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
  method: 'POST',
  query,
});
void apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
  method: 'POST',
  query: { [computedKey]: true },
});
void apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
  method: 'POST',
  query: { ...opaqueQuery },
});
void apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests', {}, {
  method: dynamicMethod,
  query: { force: true },
});
void apiFetch(dynamicPath, {}, { method: 'POST', query: { force: true } });
void apiFetch('/accounts/{accountId}/profiles/{profileId}/backtests?force=true', {}, {
  method: 'POST',
});

const params = new URLSearchParams({ force: 'true' });
void apiFetch(
  '/accounts/{accountId}/profiles/{profileId}/backtests?' + params.toString(),
  {},
  { method: 'POST' },
);
