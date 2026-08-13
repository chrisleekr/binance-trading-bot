import { describe, expect, it } from 'vitest';

import { pendingFetchForPaths } from './helpers/pending-fetch';

describe('pendingFetchForPaths', () => {
  it('accepts relative and same-origin requests for an allowed path', () => {
    const pendingFetch = pendingFetchForPaths('/api/allowed');

    expect(() => pendingFetch('/api/allowed')).not.toThrow();
    expect(() => pendingFetch(`${globalThis.location.origin}/api/allowed`)).not.toThrow();
  });

  it('rejects a wrong-origin request even when its path is allowed', () => {
    const pendingFetch = pendingFetchForPaths('/api/allowed');

    expect(() => pendingFetch('https://production.invalid/api/allowed')).toThrow(
      'Unexpected test fetch origin: /api/allowed',
    );
  });
});
