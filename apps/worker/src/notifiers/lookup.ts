// Resolves saved `profile_notifiers` rows into the `ResolvedNotifier` shape the
// notifier crons (alive digest / discovery / orphan-detect) and the
// emergency-notify path consume. Pure function: the caller owns the DB read,
// this module owns the merge rule so it can be tested without spinning up
// Postgres.
//
// Merge rule: enabled rows only; the row's `config` is the wire-visible
// shape, the row's `secrets` is the write-once column the API split out
// at save time. A provider's `send({config, payload})` expects the full
// config shape — the union of the two — so we recombine them here. On a
// key collision, `secrets` wins: a secret never gets shadowed by a
// same-named visible field, which is the invariant the API's secret-strip
// codepath assumes.

/**
 * A resolved, ready-to-send notifier: the provider name plus its full merged
 * (config + secrets) shape that `NotifyProvider.send({config, payload})`
 * expects. Owned here rather than in the executor — the `notify` Decision
 * variant was removed, so this module is the sole producer, consumed by
 * the alive digest / discovery / orphan-detect crons and the emergency-notify
 * path.
 */
export interface ResolvedNotifier {
  readonly providerName: string;
  readonly config: unknown;
}

/**
 * Narrow view of a `profile_notifiers` row. The full DB row carries
 * `id` / `profileId` / `createdAt` which the consumers do not need;
 * keeping the input shape narrow lets the worker call this helper with
 * either the typed `ProfileNotifierRow` from `@app/db` or a hand-rolled
 * fixture in tests, without coupling the worker module graph to the
 * full DB row type.
 */
export interface NotifierRowInput {
  readonly provider: string;
  readonly config: unknown;
  readonly secrets: unknown;
  readonly enabled: boolean;
}

/**
 * Build the resolved notifier list. Disabled rows are dropped; the rest carry
 * their merged (config + secrets) ready for `NotifyProvider.send`. Returns an
 * empty array when no row matches — callers treat that as "nothing to notify".
 */
export const resolveNotifiersFromRows = (
  rows: readonly NotifierRowInput[],
): readonly ResolvedNotifier[] => {
  const out: ResolvedNotifier[] = [];
  for (const row of rows) {
    if (!row.enabled) continue;
    const cfg =
      typeof row.config === 'object' && row.config !== null
        ? (row.config as Record<string, unknown>)
        : {};
    const sec =
      typeof row.secrets === 'object' && row.secrets !== null
        ? (row.secrets as Record<string, unknown>)
        : {};
    // Secrets win on key collision — see the file-level comment.
    out.push({ providerName: row.provider, config: { ...cfg, ...sec } });
  }
  return out;
};
