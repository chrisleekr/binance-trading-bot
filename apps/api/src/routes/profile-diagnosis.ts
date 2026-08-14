// "Why isn't this profile trading?" — start an investigation, watch it, read it.
//
// The api does no diagnosing. It seeds a durable `queued` row, enqueues, and
// serves the row back; the worker owns every rung. That split is what makes the
// progress the operator watches the worker's real position rather than this
// process guessing at one.
//
// The funnel view is deliberately a separate GET: the funnel is a view, the
// investigation is an action, and the panel must render without asking the
// operator to spend request weight first.

import { randomUUID } from 'node:crypto';
import {
  asProfileId,
  diagnosisRunSchema,
  discoveryFunnelResponseSchema,
  ErrorEnvelope,
  initialDiagnosisSteps,
  profileDiagnosisSchema,
  startDiagnosisRequestSchema,
  diagnosisStepSchema,
  type DiagnosisRun,
} from '@app/contracts';
import { projections, type schema } from '@app/db';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { HttpError } from 'middleware/error.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { requireUser } from 'middleware/require-user.js';
import { requireOwnedProfile, scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

const ProfileIdParam = z.object({ profileId: z.uuid() });
const RunParam = z.object({ profileId: z.uuid(), runId: z.uuid() });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(5) });

/** Scans the funnel panel reads. Matches the diagnosis worker's window so both strips agree. */
const FUNNEL_SNAPSHOT_LIMIT = 40;

/**
 * Keep the newest few investigations per profile. A diagnosis is a moment's
 * reading, not a ledger — the value is in the current one and enough history to
 * see "it said the same thing yesterday".
 */
const RUNS_KEPT = 20;

const toDiagnosisRun = (row: schema.DiagnosisRunRow): DiagnosisRun => ({
  id: row.id,
  status: row.status,
  // Validate the opaque jsonb at the response boundary. A row written by an
  // older shape degrades to an empty ladder rather than 500-ing the poll the
  // operator is watching.
  steps: z.array(diagnosisStepSchema).safeParse(row.steps).data ?? [],
  report: profileDiagnosisSchema.safeParse(row.report).data ?? null,
  error: row.error,
  startedAtMs: row.startedAt.getTime(),
  finishedAtMs: row.finishedAt?.getTime() ?? null,
});

const startRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/diagnosis/runs',
  tags: ['profiles'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: startDiagnosisRequestSchema } } },
  },
  responses: {
    202: {
      description: 'investigation queued',
      content: { 'application/json': { schema: diagnosisRunSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/diagnosis/runs',
  tags: ['profiles'],
  request: { params: ProfileIdParam, query: ListQuery },
  responses: {
    200: {
      description: 'recent investigations, newest first',
      content: { 'application/json': { schema: z.array(diagnosisRunSchema) } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/diagnosis/runs/{runId}',
  tags: ['profiles'],
  request: { params: RunParam },
  responses: {
    200: {
      description: 'one investigation',
      content: { 'application/json': { schema: diagnosisRunSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const funnelRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/discovery/funnel',
  tags: ['profiles'],
  request: { params: ProfileIdParam },
  responses: {
    200: {
      description: 'discovery funnel from the stored scans',
      content: { 'application/json': { schema: discoveryFunnelResponseSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

export const profileDiagnosisRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/diagnosis/*', requireUser());
  app.use('/profiles/*/discovery/funnel', requireUser());
  // Reading a finished report is harmless and stays on for the demo. Starting
  // one is not: the public demo injects the sole operator id, so an anonymous
  // visitor could enqueue runs whose live re-probe spends the account's Binance
  // request weight. Per-account rate isolation is a core invariant, and a
  // diagnostic must not be the thing that trips it.
  app.on('POST', '/profiles/:profileId/diagnosis/runs', requireNotDemo(di));

  app.openapi(startRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    // The profile row is not read, but its absence must 404 before a run row is
    // seeded — a report on a profile that is gone would be fabrication.
    const { p } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    const { liveProbe } = c.req.valid('json');

    // Seeded `queued` with the full ladder BEFORE the enqueue, so the 202 the
    // client renders already has every rung and the first poll can never 404.
    const runId = randomUUID();
    const row = await p.diagnosisRuns.create({
      id: runId,
      steps: initialDiagnosisSteps(),
      now: new Date(),
    });

    try {
      await di.diagnosisQueue.add(
        'profile-diagnosis',
        { runId, userId: operatorId, accountId, profileId, liveProbe },
        // Keyed on the run id, so it de-duplicates a redelivery of THIS job and
        // nothing else. Two clicks are two runs by design: each is a reading of
        // a different moment. A static key would instead make the second click
        // silently return the first click's answer.
        {
          jobId: `diagnosis:${runId}`,
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      );
    } catch (err) {
      // The row exists but nothing will drain it. Mark it errored so the polling
      // UI stops waiting on a run that was never dispatched.
      await p.diagnosisRuns.fail(runId, 'The investigation could not be started.', new Date());
      throw err;
    }

    // Bounded here rather than on a cron: a profile only accrues runs when the
    // operator clicks, so the click is the only moment the cap can be breached.
    await p.diagnosisRuns.pruneKeepNewest(RUNS_KEPT);

    c.set('auditEvent', { event: 'start-profile-diagnosis', payload: { profileId, liveProbe } });
    return c.json(toDiagnosisRun(row), 202);
  });

  app.openapi(listRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    const rows = await p.diagnosisRuns.listForProfile(c.req.valid('query').limit);
    return c.json(rows.map(toDiagnosisRun), 200);
  });

  app.openapi(getRoute, async (c) => {
    const { profileId: rawProfileId, runId } = c.req.valid('param');
    const p = await scopeOf(c, di, asProfileId(rawProfileId));
    // Scoped lookup: a run id belonging to another account's profile does not
    // resolve, so it 404s here rather than leaking a report.
    const row = await p.diagnosisRuns.findById(runId);
    if (!row) throw new HttpError('NOT_FOUND', 'diagnosis-run');
    return c.json(toDiagnosisRun(row), 200);
  });

  app.openapi(funnelRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const p = await scopeOf(c, di, profileId);
    const funnel = await projections.getDiscoveryFunnelView(
      p.scope,
      FUNNEL_SNAPSHOT_LIMIT,
      Date.now(),
    );
    return c.json({ funnel }, 200);
  });

  return app;
};
