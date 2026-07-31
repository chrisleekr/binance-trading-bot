import { describe, expect, it } from 'vitest';

import { parseRole, runsApi, runsLive, runsStudy, type Role } from '../src/role/index.js';

describe('parseRole', () => {
  it('defaults an unset value to all', () => {
    expect(parseRole(undefined)).toBe('all');
  });

  it('accepts each known role', () => {
    for (const role of ['api', 'worker', 'study', 'all'] as const) {
      expect(parseRole(role)).toBe(role);
    }
  });

  it('rejects an unknown role', () => {
    expect(() => parseRole('live')).toThrow(/Invalid ROLE/);
  });
});

describe('role predicates', () => {
  // Matrix of which capabilities each role enables.
  const matrix: Record<Role, { api: boolean; live: boolean; study: boolean }> = {
    api: { api: true, live: false, study: false },
    worker: { api: false, live: true, study: false },
    study: { api: false, live: false, study: true },
    all: { api: true, live: true, study: true },
  };

  for (const [role, want] of Object.entries(matrix) as [Role, (typeof matrix)[Role]][]) {
    it(`${role} enables the right capabilities`, () => {
      expect(runsApi(role)).toBe(want.api);
      expect(runsLive(role)).toBe(want.live);
      expect(runsStudy(role)).toBe(want.study);
    });
  }
});
