import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_INFRA, setupApp, TRAILING_TRADE_VERSION, type ApiFixture } from '../_helpers.js';

/**
 * Verifies POST /profiles/:id/switch-strategy:
 * - validates the strategy is registered
 * - resets state to the new strategy's initial state
 * - auto-pauses (enabled = false)
 * - audit-logs `switch-strategy`
 */
const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('POST /profiles/:profileId/switch-strategy', () => {
  let fx: ApiFixture;

  beforeAll(async () => {
    fx = await setupApp();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('rejects an unknown strategy with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/switch-strategy`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          strategyName: 'no-such-strategy',
          strategyVersion: '1.0.0',
          config: {},
        }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('rejects an invalid config for the target strategy with 422', async () => {
    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/switch-strategy`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          strategyName: 'trailing-trade',
          strategyVersion: TRAILING_TRADE_VERSION,
          // Missing required fields per TTConfigSchema.
          config: { symbol: 'BTCUSDT' },
        }),
      },
    );
    expect(res.status).toBe(422);
  });

  it('on success, returns the updated profile, resets state, auto-pauses, and audit-logs', async () => {
    // Pre-flip enabled to true and stash a "dirty" state row so the
    // reset is observable rather than a no-op against the default.
    await fx.di.pool.query(`update profiles set enabled = true where id = $1`, [
      fx.alice.profileId,
    ]);
    await fx.di.pool.query(`update profiles set state = $2::jsonb where id = $1`, [
      fx.alice.profileId,
      JSON.stringify({
        schemaVersion: '1.0.0',
        avgEntryPrice: '999.99',
        disabledUntilMs: null,
        triggers: { override: null },
      }),
    ]);

    const res = await fx.app.request(
      `/api/accounts/${fx.alice.accountId}/profiles/${fx.alice.profileId}/switch-strategy`,
      {
        method: 'POST',
        headers: {
          'x-test-user-id': fx.alice.userId,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          strategyName: 'trailing-trade',
          strategyVersion: TRAILING_TRADE_VERSION,
          config: {
            symbol: 'BTCUSDT',
            buy: { enabled: true, maxPurchaseAmount: '10', avgEntryPriceRemoveThreshold: '0' },
            sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
          },
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { strategyName: string; enabled: boolean };
    expect(body.strategyName).toBe('trailing-trade');
    expect(body.enabled).toBe(false);

    // State must be replaced with the strategy's fresh initialState, not the
    // pre-existing row with avgEntryPrice = '999.99'. Asserted against the
    // persisted column: `ProfileResponse` deliberately never carries `state`,
    // so the old `body.state.avgEntryPrice` check could not have run.
    const stateRow = await fx.di.pool.query<{ state: { avgEntryPrice: string | null } }>(
      `select state from profiles where id = $1`,
      [fx.alice.profileId],
    );
    expect(stateRow.rows[0]?.state.avgEntryPrice).toBeNull();

    // Constrain the audit assertion to this event type so a concurrent
    // audit row for the same user can't make the test flake.
    const audit = await fx.di.pool.query<{ event: string; payload: unknown }>(
      `select event, payload from audit_logs
       where operator_id = $1 and event = 'switch-strategy'
       order by created_at desc limit 1`,
      [fx.alice.userId],
    );
    expect(audit.rows[0]?.event).toBe('switch-strategy');
  });
});
