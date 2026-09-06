// The provisioning half of this rule needs a Docker socket, which the integration lane does not have: `scripts/ci/test-integration.sh` leaves TESTCONTAINERS unset, so `wrapper.test.ts`'s Docker block never runs in CI. Testing the decision on its own is what keeps "TESTCONTAINERS=1 wins when both are set" pinned in every lane instead of only on a developer's machine.
import { afterEach, describe, expect, it } from 'vitest';

import { reusableEndpoint } from '../src/index.js';

const previous = process.env['TESTCONTAINERS'];

afterEach(() => {
  if (previous === undefined) delete process.env['TESTCONTAINERS'];
  else process.env['TESTCONTAINERS'] = previous;
});

describe('reusableEndpoint', () => {
  it('reuses a caller-supplied endpoint when provisioning was not requested', () => {
    delete process.env['TESTCONTAINERS'];
    expect(reusableEndpoint('postgres://service/db')).toBe('postgres://service/db');
  });

  it('refuses to reuse when provisioning was explicitly requested', () => {
    process.env['TESTCONTAINERS'] = '1';
    expect(reusableEndpoint('postgres://service/db')).toBeUndefined();
  });

  it('provisions when neither selector names an endpoint', () => {
    delete process.env['TESTCONTAINERS'];
    expect(reusableEndpoint(undefined)).toBeUndefined();
  });

  // The value is a switch, not a truthiness check: an exported TESTCONTAINERS=0 must not be read as a request to provision.
  it('treats any value other than 1 as no request to provision', () => {
    process.env['TESTCONTAINERS'] = '0';
    expect(reusableEndpoint('postgres://service/db')).toBe('postgres://service/db');
  });
});
