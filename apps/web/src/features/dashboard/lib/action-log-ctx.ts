// An action_log row's `ctx` is `unknown` on the contract — it is the worker's
// structured detail, deliberately not versioned into the API schema. These
// readers pull the one field the activity feed shows, and must tolerate anything:
// no ctx at all, a non-object, a `results` array of foreign shapes.

import type { ActionLogEntry } from '@app/contracts';

/** The subset of a tick's per-decision outcome the feed reads. */
interface ActionLogResultShape {
  readonly type?: string;
  readonly ok?: boolean;
  readonly reason?: string;
}

interface ActionLogCtxShape {
  readonly results?: readonly unknown[];
}

const isCtxShape = (v: unknown): v is ActionLogCtxShape => {
  if (typeof v !== 'object' || v === null) return false;
  const ctx = v as Record<string, unknown>;
  return ctx['results'] === undefined || Array.isArray(ctx['results']);
};

const isResultShape = (v: unknown): v is ActionLogResultShape => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r['type'] === undefined || typeof r['type'] === 'string') &&
    (r['ok'] === undefined || typeof r['ok'] === 'boolean') &&
    (r['reason'] === undefined || typeof r['reason'] === 'string')
  );
};

/**
 * WHY the first failed order action in this row failed, or null.
 *
 * The row's `msg` already carries the reason for rows the worker wrote after this
 * landed, but the structured `results` array is the authority and survives a
 * wording change — read it, don't re-parse the sentence.
 */
export const readFailureReason = (entry: ActionLogEntry): string | null => {
  if (!isCtxShape(entry.ctx)) return null;
  for (const raw of entry.ctx.results ?? []) {
    if (!isResultShape(raw)) continue;
    if (raw.ok === false && typeof raw.reason === 'string' && raw.reason !== '') return raw.reason;
  }
  return null;
};
