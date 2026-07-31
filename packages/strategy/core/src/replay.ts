import { readFile } from 'node:fs/promises';
import { Decimal, isPlainDecimalString } from '@app/money';
import type { Issue, TickInput, TickOutput } from './contract.js';
import type { Strategy } from './contract.js';
import { assertPreviewTickAgreement } from './preview-drift.js';

export const FIXTURE_SCHEMA_VERSION = 1 as const;

/**
 * Revive a fixture balance field as a Decimal, degrading a malformed string to
 * zero. `Balance.free` / `Balance.locked` are `Decimal` on the contract but
 * decimal-strings in the JSONL fixture (the same wire format the worker revives
 * via `balance-revive.ts`); the harness mirrors that boundary so a tick reading
 * `account.balances` sees the Decimals the contract promises, not raw strings.
 */
const reviveBalanceField = (raw: unknown): Decimal =>
  typeof raw === 'string' && isPlainDecimalString(raw) ? new Decimal(raw) : new Decimal(0);

/**
 * Revive `account.balances` strings into Decimals. A no-op for the common
 * empty-balances fixture. Other account fields (`deployedQuoteAcrossProfiles`)
 * stay decimal-strings — the contract types them as strings and consumers
 * revive at their own boundary.
 */
const reviveAccount = <C, S, B extends Readonly<Record<string, unknown>>>(
  input: TickInput<C, S, B>,
): TickInput<C, S, B> => {
  // A recorded frame is a real read, so a fixture that omits `readable` is a
  // readable snapshot; only an explicit `false` marks the unreadable case.
  const readable = (input.account as { readable?: boolean }).readable ?? true;
  const balancesRaw = input.account.balances as unknown as Record<string, unknown>;
  const assets = Object.keys(balancesRaw);
  if (assets.length === 0) return { ...input, account: { ...input.account, readable } };
  const balances: Record<string, { asset: string; free: Decimal; locked: Decimal }> = {};
  for (const asset of assets) {
    const b = balancesRaw[asset] as { asset?: unknown; free?: unknown; locked?: unknown } | null;
    balances[asset] = {
      asset: typeof b?.asset === 'string' ? b.asset : asset,
      free: reviveBalanceField(b?.free),
      locked: reviveBalanceField(b?.locked),
    };
  }
  return { ...input, account: { ...input.account, balances, readable } };
};

export interface FixtureLine<C, S, B extends Readonly<Record<string, unknown>>> {
  readonly tick: number;
  readonly schemaVersion: typeof FIXTURE_SCHEMA_VERSION;
  readonly input: TickInput<C, S, B>;
  readonly expected: TickOutput<S>;
}

export interface ReplayDiff {
  readonly tick: number;
  readonly path: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface InvariantFailure {
  readonly tick: number;
  readonly issues: readonly Issue[];
}

export interface ReplayReport {
  readonly pass: boolean;
  readonly diffs: readonly ReplayDiff[];
  readonly invariantFailures: readonly InvariantFailure[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const diffValue = (
  expected: unknown,
  actual: unknown,
  path: string,
  out: ReplayDiff[],
  tick: number,
): void => {
  if (Object.is(expected, actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const max = Math.max(expected.length, actual.length);
    for (let i = 0; i < max; i++) {
      diffValue(expected[i], actual[i], `${path}[${i}]`, out, tick);
    }
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      // path is never '' — both entry calls pass 'decisions'/'nextState' and
      // every recursion appends, so the empty-path arm is unreachable.
      const childPath =
        path === ''
          ? /* v8 ignore next -- reason: root call always passes a named path, so path is never '' */ k
          : `${path}.${k}`;
      diffValue(expected[k], actual[k], childPath, out, tick);
    }
    return;
  }
  out.push({ tick, path, expected, actual });
};

export const replayFixture = async <C, S, B extends Readonly<Record<string, unknown>>>(
  strategy: Strategy<C, S, B>,
  fixturePath: string,
): Promise<ReplayReport> => {
  const raw = await readFile(fixturePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  const diffs: ReplayDiff[] = [];
  const invariantFailures: InvariantFailure[] = [];

  let threadedState: S | undefined;

  for (const line of lines) {
    const parsed = JSON.parse(line) as FixtureLine<C, S, B>;
    if (parsed.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
      throw new Error(
        `replay: schemaVersion mismatch at tick ${parsed.tick}: expected ${FIXTURE_SCHEMA_VERSION}, got ${String(parsed.schemaVersion)}`,
      );
    }

    const inputState = (threadedState ?? parsed.input.state) as S;
    const input: TickInput<C, S, B> = reviveAccount({ ...parsed.input, state: inputState });

    if (strategy.validateInvariants) {
      const issues = strategy.validateInvariants({ state: inputState, market: input.market });
      const errors = issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        invariantFailures.push({ tick: parsed.tick, issues: errors });
        continue;
      }
    }

    const actual = strategy.tick(input);

    // Drift gate: every emitted decision must agree with the strategy's own
    // previewLevels (emitted ⟹ consistent). A disagreement throws, failing the
    // replay loudly rather than silently drifting the operator's pre-trade view.
    assertPreviewTickAgreement(strategy, input, actual);

    diffValue(parsed.expected.decisions, actual.decisions, 'decisions', diffs, parsed.tick);
    diffValue(parsed.expected.nextState, actual.nextState, 'nextState', diffs, parsed.tick);

    threadedState = actual.nextState;
  }

  return {
    pass: diffs.length === 0 && invariantFailures.length === 0,
    diffs,
    invariantFailures,
  };
};
