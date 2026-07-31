import { describe, expect, it } from 'vitest';

import { buildAudit } from '../../../src/boot/builders/audit.js';
import { anyProxy, fakeDb, fakeRedis, silentLogger } from './fakes.js';

describe('buildAudit', () => {
  it('gives the drainer its own connection, distinct from the shared client', () => {
    const redis = fakeRedis();
    const a = buildAudit({
      db: fakeDb(),
      redis,
      logger: silentLogger(),
      metrics: anyProxy(),
      profileManager: { listActive: () => [] } as never,
    });

    expect(Object.keys(a).sort()).toEqual(['auditDrainer', 'auditDrainerRedis', 'auditShipper']);
    // Blocking XREADGROUP must not share the shared socket.
    expect(a.auditDrainerRedis).not.toBe(redis);
  });
});
