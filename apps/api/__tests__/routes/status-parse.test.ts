// Always-on unit coverage for the /status heartbeat parser. The full route
// suite (status.test.ts) is infra-gated on Redis/Postgres; this pins the
// degrade-to-null contract that keeps a malformed heartbeat from 500ing the
// public status surface, without standing up infra.
import { describe, expect, it } from 'vitest';

import { parseHeartbeat } from '../../src/routes/status.js';

describe('parseHeartbeat', () => {
  it('returns null for an absent key', () => {
    expect(parseHeartbeat(null)).toBeNull();
  });

  it('degrades a malformed or incomplete payload to null instead of throwing', () => {
    expect(parseHeartbeat('not-json{')).toBeNull();
    expect(parseHeartbeat('{}')).toBeNull(); // missing sha/bootedAt → schema reject → null
  });

  it('parses a well-formed heartbeat', () => {
    const raw = JSON.stringify({ sha: 'abc1234', bootedAt: '2026-02-02T00:00:00.000Z' });
    expect(parseHeartbeat(raw)).toEqual({ sha: 'abc1234', bootedAt: '2026-02-02T00:00:00.000Z' });
  });
});
