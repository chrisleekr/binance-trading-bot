// Every suite in this directory needs real Postgres and/or real Redis, so every one of them has to decide whether to run. Twelve hand-copied gates drifted into three different predicates, one of which had no `TESTCONTAINERS` branch at all, and none of them recorded WHY a suite stood down: vitest's junit reporter emits a bare `<skipped/>`, and `ctx.skip(note)` reaches only the default reporter, so a skipped suite left no trace in any artifact CI keeps. The lane then reported green while a quarter of it had never executed.
//
// The reason therefore has to ride the suite TITLE, which the json reporter preserves in `assertionResults[].ancestorTitles`. That forces the decision to collection time — `describe.skipIf` with a title chosen up front — which is also the only point at which the reason is still known.

import { describe } from 'vitest';

/** Which endpoints a suite actually touches. `both` means it needs Postgres and Redis together, not either one. */
export type InfraNeed = 'redis' | 'db' | 'both';

interface InfraGate {
  readonly enabled: boolean;
  /** Empty when `enabled`. Otherwise names the exact environment the operator has to supply, because a skipped suite's title is the only place this is ever printed. */
  readonly reason: string;
}

const REQUIRED_URLS: Record<InfraNeed, readonly string[]> = {
  redis: ['REDIS_TEST_URL'],
  db: ['DATABASE_TEST_URL'],
  both: ['DATABASE_TEST_URL', 'REDIS_TEST_URL'],
};

/**
 * Decides whether the calling suite has the infrastructure it needs. `TESTCONTAINERS=1` provisions throwaway containers through `@app/testcontainers`, so it satisfies every need on its own; otherwise CI's service-container URLs have to be present. This mirrors `withPostgres` / `withRedis`, which resolve the same two sources in the same precedence — a suite that admits itself here is one those helpers can serve.
 *
 * @param need - The endpoints the suite touches, which decides which URLs are checked when Docker is not in play.
 * @returns Whether the suite may run and, when it may not, the environment it is missing.
 */
export const infraGate = (need: InfraNeed): InfraGate => {
  if (process.env['TESTCONTAINERS'] === '1') return { enabled: true, reason: '' };

  const missing = REQUIRED_URLS[need].filter((name) => !process.env[name]);
  if (missing.length === 0) return { enabled: true, reason: '' };

  return {
    enabled: false,
    reason: `needs Docker via TESTCONTAINERS=1, or ${missing.join(' + ')}`,
  };
};

/**
 * Declares a suite that runs only with real infrastructure, folding the stand-down reason into the title so it survives into the json report the CI honesty check reads.
 *
 * @param need - The endpoints the suite touches, passed through to `infraGate`.
 * @param title - The suite name as it reads when the suite actually runs; the reason is appended only when it does not.
 * @param body - The suite body, registered either way so a skipped suite still reports the cases it would have run.
 */
export const describeInfra = (need: InfraNeed, title: string, body: () => void): void => {
  const gate = infraGate(need);

  describe.skipIf(!gate.enabled)(gate.enabled ? title : `${title} — skipped: ${gate.reason}`, body);
};
