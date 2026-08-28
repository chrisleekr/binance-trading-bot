export const socketUrl = (): string => {
  const url = new URL('/api/accounts/a/profiles/p/ws', 'https://example.test');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('since', '1');
  return url.toString();
};

export const spaNavigation = { to: '/accounts/a', search: { section: 'logs' } };
