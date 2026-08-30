// Which SETTINGS two past runs differed by. Two runs of one coin over one window are either a confirmation or a coincidence depending on that answer, and nothing on the past-runs list can give it: the list carries a config FINGERPRINT, which says whether two runs match but never what changed.
//
// The three answers this panel gives are not interchangeable, and both wrong pairings are plausible enough to ship by accident. An empty diff rendered for two genuinely identical runs reads as a comparison that failed. An empty diff rendered for a run whose config was never recorded reads as "these settings match" — a claim about two configs, one of which nobody has.

import { diffConfig, overrideLeaves, valueAtPath } from '@/shared/lib/config-diff';

/** One run as the comparison sees it: its id, the label the operator picked it by, and the two stamped fields that may both be null. */
export interface RunConfigSide {
  readonly runId: string;
  readonly label: string;
  readonly configFingerprint: string | null;
  readonly resolvedConfig: Record<string, unknown> | null;
}

/** One differing parameter, with the value each side gave it. `undefined` on a side means the key is absent there, which is a difference the operator has to see and not a value of its own. */
interface DiffRow {
  readonly path: string;
  readonly a: unknown;
  readonly b: unknown;
}

/**
 * Expand one override leaf into the scalar paths underneath it.
 *
 * `overrideLeaves` stops recursing where the BASE side has no object to descend into, which is exactly right for the override editor it was written for and wrong here: a key one run has and the other lacks then reports as `buy.trailing` carrying a JSON blob, when what the operator needs to read is `buy.trailing.enabled` and a value. Reuses the existing walker and finishes the descent rather than adding a second differ.
 *
 * @param path - The leaf's dot-path as `overrideLeaves` produced it.
 * @param value - That leaf's value; a plain object is expanded, anything else is already a leaf.
 * @returns One entry per scalar path beneath `path`, or `[path]` when there is nothing to expand.
 */
function scalarPaths(path: string, value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [path];
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [path];
  return entries.flatMap(([key, child]) => scalarPaths(`${path}.${key}`, child));
}

/**
 * Every parameter path on which two configs disagree, in both directions.
 *
 * `diffConfig` walks the keys of ONE config, so a setting present in A and missing from B is invisible to it in that direction. Comparing two runs is symmetric, and the union is what makes it so: without the second call the panel silently drops exactly the settings a schema change added or removed between the two runs, which is the case an operator comparing an old run to a new one is most likely to be looking for.
 *
 * @param a - The first run's resolved config.
 * @param b - The second run's resolved config.
 * @returns Differing scalar paths, deduplicated and sorted so the list is stable across renders.
 */
function differingPaths(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const [base, other] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const leaf of overrideLeaves(base, diffConfig(base, other))) {
      for (const path of scalarPaths(leaf.path, leaf.override)) paths.add(path);
    }
  }
  return [...paths].sort();
}

/** Render one config value for reading: an absent key says so in words rather than showing nothing, which is indistinguishable from an empty value. */
function renderValue(value: unknown): string {
  return value === undefined ? 'not set' : JSON.stringify(value);
}

/**
 * The settings two past backtest runs differed by, or why that question cannot be answered.
 *
 * Presentational: both runs arrive already fetched, so the panel has no loading state of its own and can be rendered from any surface that has two run details in hand.
 *
 * @param props - The two runs being compared; `a` is the run the operator armed first and `b` the one they picked against it.
 * @returns The differing parameters with the value on each side, a statement that the configs are identical, or a statement that one of them was never recorded.
 */
export function BacktestConfigDiff({
  a,
  b,
}: {
  a: RunConfigSide;
  b: RunConfigSide;
}): React.JSX.Element {
  const missing = [a, b].filter(
    (side) => side.configFingerprint === null || side.resolvedConfig === null,
  );
  if (missing.length > 0) {
    return (
      <p className="text-sm text-muted-fg" data-testid="backtest-config-diff-unavailable">
        The config is unavailable for {missing.map((side) => side.label).join(' and ')}. A run
        stamps the settings it executed when it finishes, so a run still in flight has not recorded
        them yet, and runs from before the stamping shipped never will. This is not a statement that
        the two configs match.
      </p>
    );
  }
  if (a.configFingerprint === b.configFingerprint) {
    return (
      <p className="text-sm text-muted-fg" data-testid="backtest-config-diff-identical">
        These two runs executed identical configs. Any difference in their results came from the
        market window, not from the settings.
      </p>
    );
  }
  const configA = a.resolvedConfig ?? {};
  const configB = b.resolvedConfig ?? {};
  const rows: DiffRow[] = differingPaths(configA, configB).map((path) => ({
    path,
    a: valueAtPath(configA, path),
    b: valueAtPath(configB, path),
  }));
  return (
    <div data-testid="backtest-config-diff">
      {/* Two runs whose fingerprints disagree must differ SOMEWHERE, so an empty list here is the panel failing to find it rather than a finding of its own, and it says so instead of rendering nothing. */}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-fg">
          The two runs carry different config fingerprints, but no differing parameter could be
          read. The stored configs may predate a settings rename.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.path} className="py-2 text-sm">
              <div className="font-mono text-xs break-all text-muted-fg">{row.path}</div>
              <div className="mt-1 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[11px] text-muted-fg">{a.label}</div>
                  <div className="font-mono text-xs break-all">{renderValue(row.a)}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-fg">{b.label}</div>
                  <div className="font-mono text-xs break-all">{renderValue(row.b)}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
