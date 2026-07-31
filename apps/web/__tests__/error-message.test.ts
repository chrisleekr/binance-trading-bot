import { describe, expect, it } from 'vitest';

import { ApiError, errorMessage } from '../src/shared/lib/api.js';

describe('errorMessage', () => {
  it('renders an ApiError as "code: message"', () => {
    expect(errorMessage(new ApiError(409, 'CONFLICT', 'already exists'))).toBe(
      'CONFLICT: already exists',
    );
  });

  it('renders a plain Error as its message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back to "request failed" for a non-Error throw value', () => {
    expect(errorMessage('nope')).toBe('request failed');
    expect(errorMessage(undefined)).toBe('request failed');
    expect(errorMessage({ code: 'x' })).toBe('request failed');
  });
});
