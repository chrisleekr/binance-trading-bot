// Config diff between a base config and an edited config.
//
// Two consumers: the per-symbol override editor (a save persists only the
// leaves that differ from the profile config, so the symbol keeps inheriting
// future profile-config edits) and the backtest "apply to live config" flow
// (the confirm dialog lists exactly which fields a finished run would change).
// `AutoForm` seeds every field from the JSON-schema defaults, so a naive
// whole-config comparison would treat untouched defaults as edits; `diffConfig`
// extracts only the leaves that actually differ.

/** Plain object — not an array, not null. The only shape the diff recurses into. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural equality — arrays and scalars compared whole, objects key-by-key. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Minimal override that, deep-merged onto `base`, yields `current`. Plain
 * objects recurse; arrays and scalars are compared whole and replace on any
 * difference (a grid ladder is replace-not-merge). Returns `null` when
 * `current` equals `base` — nothing to override. Keys present in `base` but
 * absent from `current` are ignored: a deep-merge override cannot delete a
 * key, and the form always carries every schema field anyway.
 */
export function diffConfig(
  base: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, cur] of Object.entries(current)) {
    const b = base[key];
    if (isPlainObject(cur) && isPlainObject(b)) {
      const sub = diffConfig(b, cur);
      if (sub !== null) out[key] = sub;
    } else if (!deepEqual(cur, b)) {
      out[key] = cur;
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** One overridden leaf: its dot-path, the override value, and the inherited profile value. */
export interface OverrideLeaf {
  readonly path: string;
  readonly override: unknown;
  readonly inherited: unknown;
}

/**
 * Flatten an override partial into leaf entries for the summary panel. Each
 * leaf carries the dot-path (`buy.maxPurchaseAmount`), the override value,
 * and the inherited value the same path holds in `base`.
 */
export function overrideLeaves(
  base: Record<string, unknown>,
  override: Record<string, unknown> | null,
): OverrideLeaf[] {
  if (override === null) return [];
  const leaves: OverrideLeaf[] = [];
  const walk = (ov: Record<string, unknown>, bs: Record<string, unknown>, prefix: string): void => {
    for (const [key, ovVal] of Object.entries(ov)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const bsVal = bs[key];
      if (isPlainObject(ovVal) && isPlainObject(bsVal)) {
        walk(ovVal, bsVal, path);
      } else {
        leaves.push({ path, override: ovVal, inherited: bsVal });
      }
    }
  };
  walk(override, base, '');
  return leaves;
}

/** Read a dot-path value out of a nested config object. */
export function valueAtPath(config: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = config;
  for (const seg of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[seg];
  }
  return cursor;
}
