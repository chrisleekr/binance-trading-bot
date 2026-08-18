import {
  asProfileId,
  asProfileNotifierId,
  ClosedTradesQuery,
  ClosedTradesResponse,
  DashboardAggregateResponse,
  BenchmarkMode,
  type DecimalString,
  type EntryBlockerResponse,
  EquitySnapshotsQuery,
  EquitySnapshotsResponse,
  ErrorEnvelope,
  NotifyProviderConfigSave,
  NotifyProviderList,
  NotifyProviderSavedConfig,
  NotifyProviderSaveResponse,
  NotifyProviderTestFireResponse,
  ProfileDashboardResponse,
} from '@app/contracts';
import { projections } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { periodWindow } from 'lib/period-window.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { accountScopeOf, requireOwnedProfile, scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });

const profileDashboardRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/dashboard',
  tags: ['dashboard'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'composite',
      content: { 'application/json': { schema: ProfileDashboardResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const aggregateRoute = createRoute({
  method: 'get',
  path: '/dashboard-aggregate',
  tags: ['dashboard'],
  responses: {
    200: {
      description: 'fan-in',
      content: { 'application/json': { schema: DashboardAggregateResponse } },
    },
  },
});

const closedTradesRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/closed-trades',
  tags: ['dashboard'],
  request: { params: ProfileIdParam, query: ClosedTradesQuery },
  responses: {
    200: {
      description: 'period totals',
      content: { 'application/json': { schema: ClosedTradesResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const equitySnapshotsRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/equity-snapshots',
  tags: ['dashboard'],
  request: { params: ProfileIdParam, query: EquitySnapshotsQuery },
  responses: {
    200: {
      description: 'net-P/L time series',
      content: { 'application/json': { schema: EquitySnapshotsResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const notifyProvidersRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/notify-providers',
  tags: ['dashboard'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'providers',
      content: { 'application/json': { schema: NotifyProviderList } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const ProfileNotifierParam = z.object({
  profileId: z.uuid(),
  name: z.string().min(1).max(64),
});

// Round-trips the persisted (config + enabled) for a single provider so the
// SPA save UI can seed its editor without re-deriving from the descriptor
// list. Secrets live in a separate column and are masked by exclusion: the
// response carries only the non-secret `config` payload.
const notifyProviderGetRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/notify-providers/{name}',
  tags: ['dashboard'],
  request: { params: ProfileNotifierParam },
  responses: {
    200: {
      description:
        'saved config (secrets masked by exclusion); `enabled` and `config` are null when no row has been saved yet',
      content: { 'application/json': { schema: NotifyProviderSavedConfig } },
    },
    404: {
      description: 'unknown provider name (a configured-but-empty provider returns 200)',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const notifyProviderSaveRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/notify-providers/{name}',
  tags: ['dashboard'],
  request: {
    params: ProfileNotifierParam,
    body: { content: { 'application/json': { schema: NotifyProviderConfigSave } } },
  },
  responses: {
    200: {
      description: 'saved',
      content: { 'application/json': { schema: NotifyProviderSaveResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

// Toggle a provider's enabled flag on its own, decoupled from the config Save.
// A distinct `/enabled` sub-path segment for the same greedy-capture reason as
// test-fire below. The point of the separate endpoint is that it does NOT
// re-validate config: an operator can switch a notifier off without first
// completing its form (the Save route's validation makes that impossible).
const notifyProviderEnabledRoute = createRoute({
  method: 'patch',
  path: '/profiles/{profileId}/notify-providers/{name}/enabled',
  tags: ['dashboard'],
  request: {
    params: ProfileNotifierParam,
    body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } },
  },
  responses: {
    200: {
      description: 'enabled flag updated',
      content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// `test-fire` is an action sub-path on the provider resource. It must be a
// distinct path segment, not a `{name}:test-fire` colon-verb suffix: Hono
// captures `{name}` greedily within a segment, so the colon form routes to
// the bare `{name}` save handler with name = `webhook:test-fire` and 422s.
const notifyProviderTestFireRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/notify-providers/{name}/test-fire',
  tags: ['dashboard'],
  request: { params: ProfileNotifierParam },
  responses: {
    200: {
      description: 'fired (ok flag carries the outcome)',
      content: { 'application/json': { schema: NotifyProviderTestFireResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const dashboardRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*', requireUser());
  app.use('/dashboard-aggregate', requireUser());
  // Live demo: lock the per-provider notifier surface. A demo visitor carries
  // the operator id, so requireUser no longer gates these — this does. It covers
  // reading the saved `config` (which holds the webhook url / chat id, NOT in
  // secretFields), overwriting it, toggling `enabled`, and firing a test send
  // through the real seeded webhook. The `:name` subtree only — the descriptor
  // LIST (`/notify-providers`, no name) carries no saved config and stays open.
  // Read-only dashboard / closed-trades / equity routes also stay open: the
  // full-sandbox + nightly reset is the design, and profile delete is left open
  // (its only notify side effect is now suppressed at the dispatch chokepoint).
  app.use('/profiles/:profileId/notify-providers/*', requireNotDemo(di));

  app.openapi(profileDashboardRoute, async (c) => {
    const p = await scopeOf(c, di, asProfileId(c.req.valid('param').profileId));
    // Read the enabled-notifier count fresh (one PG select) rather than from
    // the 5s dashboard cache, so a just-saved notifier clears the SPA's "no
    // notifications" banner without waiting out the TTL.
    const [dashboard, notifiers] = await Promise.all([
      projections.getProfileDashboard(p.scope, di.redis.raw()),
      p.profileNotifiers.listForProfile(),
    ]);
    const enabledNotifierCount = notifiers.filter((n) => n.enabled).length;
    // Enrich every symbol with its persisted blockers in one batch query (the
    // dashboard cache predates the fields, so they're read live here). A symbol
    // whose state has no blocker is absent from the map, decoding to null.
    const rows = await p.symbolStates.findBySymbols(dashboard.symbols.map((s) => s.symbol));
    const blockers = new Map<string, EntryBlockerResponse>();
    const stopBlockers = new Map<string, EntryBlockerResponse>();
    for (const r of rows) {
      const b = projections.readEntryBlocker(r.state);
      if (b) blockers.set(r.symbol, b);
      const sb = projections.readProtectiveStopBlocker(r.state);
      if (sb) stopBlockers.set(r.symbol, sb);
    }
    const symbols = dashboard.symbols.map((s) => ({
      ...s,
      entryBlocker: blockers.get(s.symbol) ?? null,
      protectiveStopBlocker: stopBlockers.get(s.symbol) ?? null,
    }));
    return c.json({ ...dashboard, enabledNotifierCount, symbols }, 200);
  });

  app.openapi(aggregateRoute, async (c) => {
    const a = await accountScopeOf(c, di);
    const aggregate = await projections.getAggregateForAccount(a.scope, di.redis.raw());
    return c.json(aggregate, 200);
  });

  app.openapi(closedTradesRoute, async (c) => {
    // Needs the profile row, not just the scope: the archive spans every quote the profile has ever traded, so the widget has to name the one it is counting in.
    const { p, profile } = await requireOwnedProfile(
      c,
      di,
      asProfileId(c.req.valid('param').profileId),
    );
    const { period, tz } = c.req.valid('query');
    const { from, to } = periodWindow(period, tz, new Date());
    const closedTrades = await projections.getClosedTradesForPeriod(p.scope, {
      period,
      tz,
      from,
      to,
      quoteAsset: profile.quoteAsset,
    });
    return c.json(closedTrades, 200);
  });

  app.openapi(equitySnapshotsRoute, async (c) => {
    const p = await scopeOf(c, di, asProfileId(c.req.valid('param').profileId));
    const { from, to, limit } = c.req.valid('query');
    const profile = await p.profile.findById();
    // `scopeOf` already proved the profile is reachable, so a missing row means it went away under this request. Substituting `''` would read the series in a currency nothing settles in, and the route would answer 200 with no points and an empty denomination label — "you have no equity history" in place of "gone", and a claim about currency the response cannot make.
    if (!profile) throw new HttpError('NOT_FOUND', `profile ${p.scope.profileId}`);
    const rows = await p.equitySnapshots.listForProfileInRange(
      // The response labels every point with this same value, so the series has to be READ in it too — otherwise a quote change leaves an old-currency tail plotted under the new label.
      profile.quoteAsset,
      from ? new Date(from) : new Date(0),
      to ? new Date(to) : new Date(),
      limit,
    );
    return c.json(
      {
        profileId: p.scope.profileId,
        quoteAsset: profile.quoteAsset,
        // Parse at the boundary (fail safe to 'btc') rather than asserting: the
        // column is plain text, guarded only by a DB CHECK on writes.
        benchmarkMode: BenchmarkMode.catch('btc').parse(profile.benchmarkMode),
        points: rows.map((r) => ({
          capturedAt: r.capturedAt.toISOString(),
          netPnlQuote: r.netPnlQuote as DecimalString,
          realizedNetQuote: r.realizedNetQuote as DecimalString,
          positionValueQuote: r.positionValueQuote as DecimalString,
          positionCostQuote: r.positionCostQuote as DecimalString,
          benchmarkAsset: r.benchmarkAsset,
          benchmarkPriceQuote: r.benchmarkPriceQuote as DecimalString,
          benchmarkPrices: (r.benchmarkPrices ?? undefined) as
            Record<string, DecimalString> | undefined,
        })),
      },
      200,
    );
  });

  app.openapi(notifyProvidersRoute, async (c) => {
    await scopeOf(c, di, asProfileId(c.req.valid('param').profileId));
    const descriptors = di.notifyProviders.describeAll().map((d) => ({
      name: d.name,
      version: d.version,
      displayName: d.displayName,
      configSchema: d.configSchema,
      secretFields: [...d.secretFields],
    }));
    return c.json(descriptors, 200);
  });

  app.openapi(notifyProviderGetRoute, async (c) => {
    const { profileId: rawProfileId, name } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(rawProfileId));
    const provider = di.notifyProviders.get(name);
    // Unknown provider name (operator pasted a malformed URL) → real 404.
    if (!provider) throw new HttpError('NOT_FOUND', `notify provider ${name}`);
    const row = await p.profileNotifiers.findByProvider(name);
    // Known provider, no saved row yet → benign empty state, not an error.
    // Return the descriptor with enabled/config null so the SPA can render
    // the empty form without each GET landing a noisy 404 in the console.
    return c.json(
      {
        name: provider.name,
        version: provider.version,
        displayName: provider.displayName,
        configSchema: provider.configSchema,
        secretFields: [...provider.secretFields],
        enabled: row?.enabled ?? null,
        config: row ? ((row.config ?? {}) as Record<string, unknown>) : null,
      },
      200,
    );
  });

  app.openapi(notifyProviderSaveRoute, async (c) => {
    const { profileId: rawProfileId, name } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(rawProfileId));
    const provider = di.notifyProviders.get(name);
    if (!provider) {
      throw new HttpError('VALIDATION_FAILED', 'unknown notify provider', { name });
    }
    const body = c.req.valid('json');
    // Load any existing row so blank / omitted secret fields on the incoming
    // payload mean "keep the stored value" rather than wiping it. Without
    // this, the SPA's Replace flow that masks secrets would either fail
    // validation (when the provider requires the field) or land an empty
    // string on disk. The visible config is still replaced wholesale per
    // the contract.
    const existingRows = await p.profileNotifiers.listForProfile();
    const existing = existingRows.find((r) => r.provider === name);
    const existingSecrets =
      existing && typeof existing.secrets === 'object' && existing.secrets !== null
        ? (existing.secrets as Record<string, unknown>)
        : {};
    const incoming = body.config as Record<string, unknown>;
    const secretFields = new Set(provider.secretFields);
    // Rebuild the merged object explicitly rather than mutating + deleting
    // dynamic keys (which trips @typescript-eslint/no-dynamic-delete). A
    // blank/missing secret falls back to the stored value when one exists,
    // otherwise the field is omitted entirely so the provider's required-
    // field check fires only when there's nothing stored at all.
    const mergedEntries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(incoming)) {
      if (!secretFields.has(k)) {
        mergedEntries.push([k, v]);
        continue;
      }
      if (v !== undefined && v !== null && v !== '') {
        mergedEntries.push([k, v]);
      } else if (existingSecrets[k] !== undefined) {
        mergedEntries.push([k, existingSecrets[k]]);
      }
    }
    // Secret fields the operator didn't mention at all — fill from the
    // stored secrets so the merged config still satisfies required-field
    // checks on the provider schema.
    for (const field of secretFields) {
      if (
        !Object.prototype.hasOwnProperty.call(incoming, field) &&
        existingSecrets[field] !== undefined
      ) {
        mergedEntries.push([field, existingSecrets[field]]);
      }
    }
    const merged: Record<string, unknown> = Object.fromEntries(mergedEntries);
    // Provider-owned schema is the source of truth; validate the merged
    // config so a re-save with blanked secrets doesn't 422 on required-
    // field checks the stored secret already satisfies.
    const parsed = provider.configSchema.safeParse(merged);
    if (!parsed.success) {
      throw new HttpError('VALIDATION_FAILED', 'invalid notifier config', parsed.error.issues);
    }
    // Split secret-marked fields out into the DB's `secrets` column so the
    // projection rules on read can drop the secrets without touching the
    // visible config.
    const cfgEntries: [string, unknown][] = [];
    const secrets: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed.data as Record<string, unknown>)) {
      if (secretFields.has(k)) {
        if (v !== undefined && v !== null && v !== '') secrets[k] = v;
      } else {
        cfgEntries.push([k, v]);
      }
    }
    const visibleConfig = Object.fromEntries(cfgEntries);
    await p.profileNotifiers.upsertByProvider(name, {
      config: visibleConfig,
      secrets,
      enabled: body.enabled,
    });
    c.set('auditEvent', {
      event: 'notify-provider-save',
      payload: { profileId: p.scope.profileId, provider: name, enabled: body.enabled },
    });
    return c.json(
      {
        name: provider.name,
        version: provider.version,
        displayName: provider.displayName,
        configSchema: provider.configSchema,
        secretFields: [...provider.secretFields],
        enabled: body.enabled,
      },
      200,
    );
  });

  app.openapi(notifyProviderEnabledRoute, async (c) => {
    const { profileId: rawProfileId, name } = c.req.valid('param');
    const { enabled } = c.req.valid('json');
    const p = await scopeOf(c, di, asProfileId(rawProfileId));
    // A row must already exist: enabling requires a saved (valid) config, and
    // there is nothing to disable otherwise. No config re-validation here — that
    // is exactly what makes "turn it off" possible for a half-configured row.
    const row = await p.profileNotifiers.findByProvider(name);
    if (!row) throw new HttpError('NOT_FOUND', `notifier config ${name}`);
    await p.profileNotifiers.setEnabled(asProfileNotifierId(row.id), enabled);
    c.set('auditEvent', {
      event: 'notify-provider-enabled',
      payload: { profileId: p.scope.profileId, provider: name, enabled },
    });
    return c.json({ enabled }, 200);
  });

  app.openapi(notifyProviderTestFireRoute, async (c) => {
    const { profileId: rawProfileId, name } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(rawProfileId));
    const provider = di.notifyProviders.get(name);
    if (!provider) throw new HttpError('NOT_FOUND', `notify provider ${name}`);
    const rows = await p.profileNotifiers.listForProfile();
    const row = rows.find((r) => r.provider === name);
    if (!row) throw new HttpError('NOT_FOUND', `notifier config ${name}`);
    // Merge the saved config and secrets back into the provider-shaped
    // payload. Validation is intentionally skipped here — the row passed
    // the schema gate at save time and any drift would surface as a real
    // send-time error below, which we capture into the `ok=false` response.
    const config = {
      ...(row.config as Record<string, unknown>),
      ...(row.secrets as Record<string, unknown>),
    };
    const profileName = (await p.profile.findById())?.name;
    try {
      await provider.send({
        config,
        message: {
          severity: 'info',
          topic: 'test-fire',
          title: 'Test notification',
          ...(profileName ? { profile: profileName } : {}),
          body: "Notifications are working. If you can read this, you're set.",
        },
      });
      c.set('auditEvent', {
        event: 'notify-provider-test-fire',
        payload: { profileId: p.scope.profileId, provider: name, ok: true },
      });
      return c.json({ ok: true, error: null }, 200);
    } catch {
      // Generic label, not the raw err.message — provider failures
      // routinely contain the secret-bearing webhook URL or token in the
      // error string, and both the response body and audit log are
      // persisted surfaces. Operators tracing a failed test-fire read the
      // server-side provider logs (where secrets are redacted at the
      // logger boundary) for triage, not this label.
      const message = 'send failed';
      c.set('auditEvent', {
        event: 'notify-provider-test-fire',
        payload: { profileId: p.scope.profileId, provider: name, ok: false, error: message },
      });
      return c.json({ ok: false, error: message }, 200);
    }
  });

  return app;
};
