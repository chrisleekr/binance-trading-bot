/**
 * Deep-merge a per-symbol config override onto a base (profile-level)
 * config. Plain objects merge key-by-key so a partial override only has to
 * carry the keys it changes; arrays and scalars from `override` replace the
 * base value wholesale (a grid ladder is replace-not-merge, not an
 * element-wise merge). `override` of `null` / `undefined` returns `base`
 * unchanged — that is the "inherit" steady state — and the same rule applies
 * recursively: a `null` / `undefined` value at any depth leaves the matching
 * base subtree intact. Pure: neither argument is mutated.
 *
 * The result is structurally a `Config` only when the override carries no
 * unknown keys; the caller is expected to re-validate the merged object
 * through the strategy's `configSchema` before trusting it. Prototype-chain keys
 * (`__proto__`, `constructor`, `prototype`) in `override` are always dropped,
 * independent of that re-validation, so a merge can never pollute
 * `Object.prototype`.
 */
export const mergeConfig = <T>(base: T, override: unknown): T => {
  if (override === null || override === undefined) return base;
  // Type-preserving coercion: decimal config fields are decimal-strings (the
  // schema rejects raw numbers), but a numeric override source (e.g. an advisor
  // config patch) sends a number. When the base field is a string, stringify
  // the numeric override so it survives configSchema parse.
  // Inert for the live per-symbol merge, where overrides are already strings.
  if (typeof base === 'string' && typeof override === 'number') {
    return String(override) as T;
  }
  // Index-merge: a numeric-keyed object override onto an array base patches
  // elements by position (e.g. `{ "0": { whenBuy: true } }` onto the technicals
  // intervals array), keeping other elements and their untouched fields intact.
  // An override can use this shape for array-element paths like
  // `technicals.intervals.0.whenBuy`. A plain-array override still replaces the
  // base outright below (grid ladders are replace-not-merge), since an array is
  // not a numeric-keyed object, so this is inert for every existing merge.
  if (Array.isArray(base) && isPlainObject(override) && hasOnlyIndexKeys(override)) {
    const out = [...(base as readonly unknown[])];
    for (const [key, value] of Object.entries(override)) {
      const i = Number(key);
      out[i] = i < out.length ? mergeConfig(out[i], value) : value;
    }
    return out as T;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    // A non-object override (scalar or array) replaces the base outright.
    return override as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // An override can originate from untrusted persisted data (a stored backtest's
    // params). Skip prototype-chain keys so `out[key] = …` cannot walk into
    // Object.prototype; callers still re-validate, but the primitive must not rely
    // on that.
    if (UNSAFE_MERGE_KEYS.has(key)) continue;
    out[key] = key in base ? mergeConfig(base[key], value) : value;
  }
  return out as T;
};

/** Keys that index the prototype chain; never copied from an override. */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True for a non-null, non-array object — the only shape `mergeConfig` recurses into. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when an object's keys are all non-negative integer strings (`"0"`,
 * `"1"`, …), i.e. it addresses array positions. Empty objects are excluded so
 * a `{}` override keeps falling through to the wholesale-replace path.
 */
const hasOnlyIndexKeys = (obj: Record<string, unknown>): boolean => {
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
};
