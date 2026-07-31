// Process ROLE: the single knob that selects which listeners/consumers a
// process runs. One image, one entrypoint (apps/server), ROLE decides behaviour.
//
//   api    -> HTTP api + admin server (also serves the built SPA)
//   worker -> live trading consumers (crons, tick, pipeline, user-data streams)
//   study  -> backtest + advisor consumers only (kept off the live event loop)
//   all    -> api + worker + study in one process (single-box default)
//
// `all` is single-replica by deployment convention; the compose scale override
// runs api/worker/study as separate services from this same image.

export const ROLES = ['api', 'worker', 'study', 'all'] as const;

export type Role = (typeof ROLES)[number];

const isRole = (v: unknown): v is Role => (ROLES as readonly unknown[]).includes(v);

/** Parse a raw env value into a Role. Unset defaults to `all`; unknown throws. */
export const parseRole = (raw: string | undefined): Role => {
  const v = raw ?? 'all';
  if (!isRole(v)) throw new Error(`Invalid ROLE: ${v} (expected one of ${ROLES.join('|')})`);
  return v;
};

export const runsApi = (role: Role): boolean => role === 'api' || role === 'all';
export const runsLive = (role: Role): boolean => role === 'worker' || role === 'all';
export const runsStudy = (role: Role): boolean => role === 'study' || role === 'all';
