// The name space of `TickOutput.metrics`, pinned as an exact set.
//
// Every entry a strategy emits leaves the worker as one label value on the
// catalogued `strategy_metric_total` series, so the metric NAME is a label and
// the catalogue's compile-time closure does not reach it. This file is the
// closure it does not get: the set below is what an operator's dashboards and
// alert rules can name, and a rename here is a dashboard that silently stops
// resolving rather than an error anyone sees.
//
// Asserted as a SET equality on purpose. A count would pass a rename — one name
// out, one name in — which is the exact change that breaks a rule, and it would
// pass vacuously the day the walk stops matching anything.
//
// Lives here rather than in either strategy package because `@app/strategy-registry`
// is the one workspace that already depends on all three plugins, so the walk and
// the type-derived expansion can both see every emitter.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SellEmissionReason } from '@app/strategy-trailing-trade';
import { describe, expect, it } from 'vitest';

const STRATEGY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every `.ts` file under each strategy package's `src/`, tests and build output excluded. */
const strategySources = (): readonly string[] => {
  const walk = (dir: string): readonly string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
    });
  return readdirSync(STRATEGY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const src = join(STRATEGY_ROOT, entry.name, 'src');
      try {
        return walk(src);
      } catch {
        // A strategy package with no `src/` is not an emitter; skip it rather
        // than fail, and let the file-count floor below catch a broken root.
        return [];
      }
    });
};

// One `metric(` call site. Either a string literal first argument, or an
// identifier expression — the runtime-computed family.
const CALL_SITE = /\bmetric\(\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$.]*))/g;
const ANY_CALL_SITE = /\bmetric\(/g;

interface Harvest {
  readonly files: number;
  readonly literals: ReadonlySet<string>;
  readonly computed: ReadonlySet<string>;
  readonly sites: number;
  readonly matched: number;
}

const harvest = (): Harvest => {
  const literals = new Set<string>();
  const computed = new Set<string>();
  let sites = 0;
  let matched = 0;
  const files = strategySources();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    sites += source.match(ANY_CALL_SITE)?.length ?? 0;
    for (const [, single, double, expression] of source.matchAll(CALL_SITE)) {
      matched += 1;
      const literal = single ?? double;
      if (literal === undefined) computed.add(expression as string);
      else literals.add(literal);
    }
  }
  return { files: files.length, literals, computed, sites, matched };
};

// Names written out at the call site. Exact — a removal has to fail as loudly as
// an addition, so neither a dropped dashboard series nor an unreviewed new one
// can land quietly.
const LITERAL_NAMES: readonly string[] = [
  'momentum.entry',
  'momentum.exit',
  'momentum.skip',
  // Emitted from `@app/strategy-core`, so BOTH stop-resting strategies land on
  // one series and an alert rule reads the drained `strategy` label to tell them
  // apart. The plugin-prefixed names above are each written by one package.
  'protective_stop_band_adjusted',
  'rebalance.decision',
  'tt_auto_trigger_buy_emit',
  'tt_auto_trigger_buy_rescheduled',
  'tt_auto_trigger_buy_skipped',
  'tt_auto_trigger_buy_waiting',
  'tt_bull_pyramid_add',
  'tt_discovery_chase_guard_veto',
  'tt_discovery_guardrail_veto',
  'tt_discovery_knife_guard_veto',
  'tt_first_buy_skipped',
  'tt_force_sell_cooldown_blocked',
  'tt_grid_buy_emit',
  'tt_loss_cooldown_blocked',
  'tt_manual_order_emit',
  'tt_manual_order_skipped',
  'tt_protective_stop_arm',
  'tt_regime_exit_entry_block',
  'tt_regime_exposure',
  'tt_regime_filter_veto',
  'tt_risk_cap_veto',
  'tt_tick_buy_path',
  'tt_tick_pure_path',
  'tt_trigger_buy_emit',
  'tt_trigger_buy_skipped',
  'tt_trigger_sell_emit',
  'tt_trigger_sell_skipped',
  'tt_tv_force_sell_emit',
  'tt_tv_force_sell_skipped',
];

// The only call sites whose name is not a literal. Both read the name off a
// `SellGateEmit`, which `sellEmissionOrSkip` builds from its `reason`.
const COMPUTED_CALL_SITES: readonly string[] = ['sellResult.metricName', 'emission.metricName'];

// Annotated `Record<SellEmissionReason, true>`, never a plain array: the
// annotation rejects a missing key and an unlisted one, so adding a sell reason
// fails to compile here until the operator-visible series it invents is
// acknowledged. A hand-copied array would absorb a new reason in silence, which
// is the failure this file exists to prevent.
const SELL_EMISSION_REASONS: Readonly<Record<SellEmissionReason, true>> = {
  'grid-sell': true,
  'grid-stop-loss': true,
  'technicals-force-sell': true,
  'regime-exit': true,
  'discovery-time-stop': true,
  'break-even-stop': true,
  'time-stop': true,
};

/** The template `sellEmissionOrSkip` applies to its reason, mirrored here. */
const emitName = (reason: string): string => `tt_${reason.replaceAll('-', '_')}_emit`;

// Every template that builds a computed name, harvested from the same sources
// the walk already reads.
const NAME_TEMPLATE = /metricName:\s*`([^`]*)`/g;

const templates = (): readonly string[] =>
  strategySources().flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(NAME_TEMPLATE)].map(([, body]) => body as string),
  );

const sorted = (names: Iterable<string>): readonly string[] => [...names].sort();

describe('strategy metric names', () => {
  it('walks a non-empty set of strategy sources', () => {
    // Without this the set assertions below would pass on an empty harvest, and
    // a glob broken by a directory move would read as "no names changed".
    const { files, sites } = harvest();
    expect(files).toBeGreaterThan(20);
    expect(sites).toBeGreaterThan(30);
  });

  it('parses every call site it finds', () => {
    // A first argument that is neither a literal nor a plain identifier — a
    // ternary, a call, a template — would be counted and never classified, so
    // its name would escape both sets below without failing either.
    const { sites, matched } = harvest();
    expect(matched).toBe(sites);
  });

  it('emits exactly the recorded literal names', () => {
    const { literals } = harvest();
    expect(sorted(literals)).toEqual(sorted(LITERAL_NAMES));
  });

  it('computes a name at exactly the recorded call sites', () => {
    const { computed } = harvest();
    expect(sorted(computed)).toEqual(sorted(COMPUTED_CALL_SITES));
  });

  it('mirrors the template the strategy source still spells', () => {
    // The expansion below is only as good as this mirror. Rename the template in
    // the sell gate and every expanded name here stays intact and wrong, so the
    // recorded set keeps passing while the exported series quietly change.
    expect(templates()).toEqual(["tt_${reason.replaceAll('-', '_')}_emit"]);
    expect(emitName('grid-sell')).toBe('tt_grid_sell_emit');
  });

  it('expands the computed family to one series per sell reason', () => {
    expect(sorted(Object.keys(SELL_EMISSION_REASONS).map(emitName))).toEqual([
      'tt_break_even_stop_emit',
      'tt_discovery_time_stop_emit',
      'tt_grid_sell_emit',
      'tt_grid_stop_loss_emit',
      'tt_regime_exit_emit',
      'tt_technicals_force_sell_emit',
      'tt_time_stop_emit',
    ]);
  });

  it('keeps the whole name space free of collisions between the two halves', () => {
    // A literal that duplicates an expansion would make two unrelated call sites
    // share one series, and the label set carries nothing to tell them apart.
    const { literals } = harvest();
    const expanded = Object.keys(SELL_EMISSION_REASONS).map(emitName);
    expect(expanded.filter((name) => literals.has(name))).toEqual([]);
  });
});
