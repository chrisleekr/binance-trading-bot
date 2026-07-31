import type { Strategy, TickInput, TickOutput } from './contract.js';

const stableStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) throw new Error('determinism: cycle detected');
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(sort);
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sort(o[k]);
    return out;
  };
  return JSON.stringify(sort(value));
};

export interface DeterminismResult<S> {
  readonly first: TickOutput<S>;
  readonly second: TickOutput<S>;
  readonly equal: boolean;
}

export const assertDeterministic = <C, S, B extends Readonly<Record<string, unknown>>>(
  strategy: Strategy<C, S, B>,
  input: TickInput<C, S, B>,
): DeterminismResult<S> => {
  const first = strategy.tick(input);
  const second = strategy.tick(input);
  const equal = stableStringify(first) === stableStringify(second);
  if (!equal) {
    throw new Error(
      `assertDeterministic: tick produced divergent output across two runs.\n` +
        `first:  ${stableStringify(first)}\n` +
        `second: ${stableStringify(second)}`,
    );
  }
  return { first, second, equal };
};
