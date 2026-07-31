import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProfileScope } from '../../src/repo/_scoped.js';
import * as repo from '../../src/repo/index.js';
import { profileRepo } from '../../src/repo/index.js';
import { getProfileAuditLogExport, getSymbolLogs } from '../../src/repo/projections/logs.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const WINDOW_START = new Date('2026-05-11T00:00:00Z');
const WINDOW_END = new Date('2026-05-11T01:00:00Z');

describeIfDb('logs projections', () => {
  let fx: IsolationFixture;
  let scope: ProfileScope;

  beforeAll(async () => {
    fx = await setupFixture();
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    scope = ap.scope;
    await ap.actionLogs.append({
      time: new Date('2026-05-11T00:30:00Z'),
      symbol: 'BTCUSDT',
      level: 'info',
      msg: 'projection-symbol-log',
      ctx: { tag: 'logs-test' },
    });
    // audit_logs.append stays user-scoped (flat) — not on the ProfileRepo surface.
    await repo.auditLogs.append(fx.db, fx.alice.userId, {
      event: 'projection-audit-log',
      actor: 'user',
      payload: { profileId: fx.alice.profileId },
      ip: null,
      userAgent: null,
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('getSymbolLogs returns action-log rows inside the window', async () => {
    const rows = await getSymbolLogs(scope, 'BTCUSDT', WINDOW_START, WINDOW_END);
    const mine = rows.filter((r) => r.msg === 'projection-symbol-log');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ symbol: 'BTCUSDT', level: 'info' });
  });

  it('getSymbolLogs excludes rows outside the window', async () => {
    const rows = await getSymbolLogs(
      scope,
      'BTCUSDT',
      new Date('2026-05-12T00:00:00Z'),
      new Date('2026-05-12T01:00:00Z'),
    );
    expect(rows.some((r) => r.msg === 'projection-symbol-log')).toBe(false);
  });

  it('getProfileAuditLogExport shapes audit rows for the NDJSON stream', async () => {
    const rows = await getProfileAuditLogExport(scope, new Date(0), new Date('2999-01-01Z'));
    const exported = rows.find((r) => r.event === 'projection-audit-log');
    expect(exported).toBeDefined();
    expect(exported).toMatchObject({ event: 'projection-audit-log', actor: 'user' });
    expect(typeof exported?.createdAt).toBe('string');
  });
});
