export const directFetches = (): void => {
  void fetch('/api/accounts/a/profiles/p/backtests?limit=10');
  void window.fetch('/api/accounts/a/profiles/p/backtests?limit=10');
  void globalThis.fetch('/api/accounts/a/profiles/p/backtests?limit=10');
  const request = fetch;
  void request('/api/accounts/a/profiles/p/backtests?unknownKey=1');
  const url = '/api/accounts/a/profiles/p/backtests?unknownKey=1';
  void fetch(url);
  window.open('/api/accounts/a/profiles/p/logs/export?levels=warn');
  window.location.href = '/api/accounts/a/profiles/p/logs/export?levels=warn';
};

export const mixedWebSocketAndApiUrls = (): URL => {
  const ws = new URL('/api/accounts/a/profiles/p/ws', 'https://example.test');
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.searchParams.set('since', '1');
  const api = new URL('/api/accounts/a/profiles/p/backtests', 'https://example.test');
  api.searchParams.set('unknownKey', '1');
  return api;
};
