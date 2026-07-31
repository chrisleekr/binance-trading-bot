import { describe, expect, it } from 'vitest';

import { errorMessage } from '../../src/error/index.js';

describe('errorMessage', () => {
  it('returns an Error instance message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns an Error subclass message', () => {
    class DomainError extends Error {}
    expect(errorMessage(new DomainError('domain failed'))).toBe('domain failed');
  });

  it('stringifies a non-Error object rather than yielding undefined', () => {
    // A Binance error object has no `.message`; a bare cast would lose it.
    expect(errorMessage({ code: -1013 })).toBe('[object Object]');
  });

  it('returns a thrown string unchanged', () => {
    expect(errorMessage('plain failure')).toBe('plain failure');
  });

  it('stringifies null and undefined', () => {
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
