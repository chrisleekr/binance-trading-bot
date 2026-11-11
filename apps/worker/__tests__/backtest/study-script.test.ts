import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCRIPT = 'scripts/backtest-study.ts';
const FIXTURE = join(ROOT, 'apps/worker/__tests__/fixtures/backtest-study/input.jsonl');
const MIN = 60_000;
// The study replays a real matrix from a subprocess, which a unit-test default would cut short.
const STUDY_TIMEOUT_MS = 120_000;

interface StudyRow {
  readonly strategy: string;
  readonly armAtPercentage?: string;
  readonly decisionInterval: string;
  readonly costScenario: string;
  readonly breakEvenExits: number;
  readonly btc: { readonly status: string; readonly maxDrawdownPct?: number };
}

interface StudyReport {
  readonly input: { readonly sha256: string };
  readonly command: string;
  readonly configs: Record<string, unknown>;
  readonly costs: Record<string, unknown>;
  readonly controls: readonly { readonly name: string; readonly costScenario?: string }[];
  readonly candidates: readonly StudyRow[];
}

interface CandleRow {
  readonly symbol: string;
  readonly interval: string;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly close: string;
  readonly high: string;
}

const temp = mkdtempSync(join(tmpdir(), 'backtest-study-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

let runs = 0;

function runStudy(inputPath: string) {
  const id = String(++runs);
  const json = join(temp, `report-${id}.json`);
  const md = join(temp, `report-${id}.md`);
  const out = spawnSync('bun', [SCRIPT, '--input', inputPath, '--out-json', json, '--out-md', md], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return { out, json, md };
}

function study(inputPath = FIXTURE): { report: StudyReport; markdown: string } {
  const { out, json, md } = runStudy(inputPath);
  expect(out.status, out.stderr).toBe(0);
  return {
    report: JSON.parse(readFileSync(json, 'utf8')) as StudyReport,
    markdown: readFileSync(md, 'utf8'),
  };
}

// The unmodified fixture gives one answer, so the cases reading it share a single subprocess run.
let committed: ReturnType<typeof study> | undefined;
const committedStudy = (): ReturnType<typeof study> => (committed ??= study());

const fixtureRows = (): { meta: Record<string, unknown>; candles: CandleRow[] } => {
  const [first, ...rest] = readFileSync(FIXTURE, 'utf8').trim().split('\n');
  return {
    meta: JSON.parse(first as string) as Record<string, unknown>,
    candles: rest.map((line) => JSON.parse(line) as CandleRow),
  };
};

// Writes a variant of the fixture, keeping the meta line first as the script reads it.
function variant(meta: Record<string, unknown>, candles: readonly CandleRow[]): string {
  const path = join(temp, `input-${String(++runs)}.jsonl`);
  writeFileSync(path, [meta, ...candles].map((row) => JSON.stringify(row)).join('\n'));
  return path;
}

const isConversion = (c: CandleRow): boolean => c.symbol === 'BTCUSDT' && c.interval === '1m';
const conversionCloses = (candles: readonly CandleRow[]): number[] =>
  candles.filter(isConversion).map((c) => c.closeTimeMs);

const trailing = (report: StudyReport, arm: string, decision: string, cost: string): StudyRow => {
  const row = report.candidates.find(
    (c) =>
      c.strategy === 'trailing-trade' &&
      c.armAtPercentage === arm &&
      c.decisionInterval === decision &&
      c.costScenario === cost,
  );
  expect(row, `trailing-trade ${arm} ${decision} ${cost}`).toBeDefined();
  return row as StudyRow;
};

describe('missing or stale conversion is unavailable; drawdown uses full-resolution marks, no future candle', () => {
  const allBtc = (report: StudyReport): string[] => [
    ...new Set(report.candidates.map((c) => c.btc.status)),
  ];

  it(
    'reports a missing input and names it',
    () => {
      const missing = join(temp, 'absent.jsonl');
      const { out } = runStudy(missing);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain(missing);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'computes a BTC result on the committed fixture',
    () => {
      const { report } = committedStudy();
      expect(allBtc(report)).toEqual(['ok']);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'reports BTC unavailable when the conversion series is absent',
    () => {
      const { meta, candles } = fixtureRows();
      const { report } = study(
        variant(
          meta,
          candles.filter((c) => !isConversion(c)),
        ),
      );
      expect(allBtc(report)).toEqual(['unavailable']);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'reports BTC unavailable and names a required series the input lacks',
    () => {
      const { meta, candles } = fixtureRows();
      const configs = meta['configs'] as Record<string, Record<string, unknown>>;
      const trailingConfig = configs['trailing-trade'] as { technicals: Record<string, unknown> };
      const technicals = { ...trailingConfig.technicals, intervals: [{ interval: '5m' }] };
      const withTechnicals = {
        ...meta,
        configs: { ...configs, 'trailing-trade': { ...trailingConfig, technicals } },
      };
      const { report } = study(variant(withTechnicals, candles));
      const rows = report.candidates.filter((c) => c.strategy === 'trailing-trade');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.btc).toEqual({
          status: 'unavailable',
          reason: 'missing input series: ETHUSDT|5m',
        });
      }
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'reports BTC unavailable when the daily series the live feed reads is absent',
    () => {
      const { meta, candles } = fixtureRows();
      const { report } = study(
        variant(
          meta,
          candles.filter((c) => c.interval !== '1d'),
        ),
      );
      const rows = report.candidates.filter((c) => c.strategy === 'trailing-trade');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.btc).toEqual({
          status: 'unavailable',
          reason: 'missing input series: ETHUSDT|1d',
        });
      }
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'reports BTC unavailable when the daily series only has candles after the window',
    () => {
      const { meta, candles } = fixtureRows();
      const toMs = meta['toMs'] as number;
      const late = candles.map((c) =>
        c.interval === '1d' ? { ...c, openTimeMs: toMs, closeTimeMs: toMs + 86_400_000 - 1 } : c,
      );
      const { report } = study(variant(meta, late));
      const rows = report.candidates.filter((c) => c.strategy === 'trailing-trade');
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.btc).toEqual({
          status: 'unavailable',
          reason: 'missing input series: ETHUSDT|1d',
        });
      }
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'rejects an input without a usable maxConversionStalenessMs',
    () => {
      const { meta, candles } = fixtureRows();
      const { maxConversionStalenessMs: _omitted, ...rest } = meta;
      const { out } = runStudy(variant(rest, candles));
      expect(out.status).not.toBe(0);
      expect(out.stderr).toContain('non-negative maxConversionStalenessMs');
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'reports BTC unavailable when the conversion series goes stale',
    () => {
      const { meta, candles } = fixtureRows();
      const closes = conversionCloses(candles);
      const staleFrom = closes[3] as number;
      const last = closes.at(-1) as number;
      const kept = candles.filter(
        (c) => !isConversion(c) || c.closeTimeMs <= staleFrom || c.closeTimeMs === last,
      );
      const { report } = study(variant({ ...meta, maxConversionStalenessMs: 2 * MIN }, kept));
      expect(allBtc(report)).toEqual(['unavailable']);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'does not value the opening marks with a candle closing after them',
    () => {
      const { meta, candles } = fixtureRows();
      const closes = conversionCloses(candles);
      const firstKept = closes[Math.floor(closes.length / 2)] as number;
      const kept = candles.filter((c) => !isConversion(c) || c.closeTimeMs >= firstKept);
      const { report } = study(variant(meta, kept));
      expect(allBtc(report)).toEqual(['unavailable']);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'sees a conversion spike that falls between five-minute decisions',
    () => {
      const { meta, candles } = fixtureRows();
      const conversion = candles.filter(isConversion);
      // A close at minute 3 of a five-minute span is never a decision boundary, so only a per-frame mark sees it.
      const target = conversion.find(
        (c, i) => i > 10 && (c.closeTimeMs + 1) % (5 * MIN) === 3 * MIN,
      ) as CandleRow;
      const doubled = String(Number(target.close) * 2);
      const spiked = candles.map((c) =>
        isConversion(c) && c.closeTimeMs === target.closeTimeMs
          ? { ...c, close: doubled, high: doubled }
          : c,
      );
      const { report } = study(variant(meta, spiked));
      const dd = trailing(report, '1.01', '5m', 'base').btc.maxDrawdownPct as number;
      expect(dd).toBeGreaterThan(45);
    },
    STUDY_TIMEOUT_MS,
  );
});

describe('runs the committed fixture through the worker replay; 1.02 changes a decision vs 1.01', () => {
  it('imports the replay the worker runs', () => {
    expect(readFileSync(join(ROOT, SCRIPT), 'utf8')).toMatch(
      /apps\/worker\/src\/backtest\/replay\.js/,
    );
  });

  it(
    'takes the break-even exit at 1.01',
    () => {
      const { report } = committedStudy();
      expect(trailing(report, '1.01', '1m', 'base').breakEvenExits).toBeGreaterThan(0);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'skips that exit at 1.02',
    () => {
      const { report } = committedStudy();
      expect(trailing(report, '1.02', '1m', 'base').breakEvenExits).toBe(0);
    },
    STUDY_TIMEOUT_MS,
  );
});

describe('report contains input, hashes, command, configs, costs, controls and every candidate', () => {
  it(
    'hashes the exact input bytes',
    () => {
      const expected = createHash('sha256').update(readFileSync(FIXTURE)).digest('hex');
      expect(committedStudy().report.input.sha256).toBe(expected);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'records the command that produced it',
    () => {
      expect(committedStudy().report.command).toContain(SCRIPT);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'records the configs and both cost scenarios',
    () => {
      const { report } = committedStudy();
      expect(Object.keys(report.configs).length).toBeGreaterThan(0);
      expect(report.costs).toMatchObject({
        base: { commissionBps: 10, slippageBps: 2, spreadBps: 2 },
        stress: { commissionBps: 10, slippageBps: 10, spreadBps: 10 },
      });
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'runs every break-even candidate at both cadences and cost scenarios',
    () => {
      const keys = committedStudy()
        .report.candidates.filter((c) => c.strategy === 'trailing-trade')
        .map((c) => `${String(c.armAtPercentage)}|${c.decisionInterval}|${c.costScenario}`)
        .sort();
      const expected: string[] = [];
      for (const arm of ['1.01', '1.02', '1.03'])
        for (const decision of ['1m', '5m'])
          for (const cost of ['base', 'stress']) expected.push(`${arm}|${decision}|${cost}`);
      expect(keys).toEqual(expected.sort());
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'runs Momentum as a control at both cadences and cost scenarios',
    () => {
      const rows = committedStudy().report.candidates.filter((c) => c.strategy === 'momentum');
      expect(rows).toHaveLength(4);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'reports the cash, BTC reference, passive and funded BTC-hold controls',
    () => {
      const names = new Set(committedStudy().report.controls.map((c) => c.name));
      expect([...names].sort()).toEqual(['btc-hold', 'cash', 'passive-basket', 'zero-pct-btc']);
    },
    STUDY_TIMEOUT_MS,
  );
});

describe('discloses fixed universe, flat start, terminal marking, unmodelled pauses and discovery, path uncertainty; never says untouched', () => {
  const required: readonly [string, RegExp][] = [
    ['fixed universe', /fixed[- ](current[- ])?(universe|basket)/i],
    ['flat start', /flat[- ]start/i],
    ['terminal marking', /terminal mark|marked at the end|without forced liquidation/i],
    ['unmodelled worker pauses', /worker.*pause|loss pause/i],
    ['unmodelled discovery', /discovery/i],
    ['candle-path uncertainty', /candle[- ]path/i],
  ];

  it.each(required)(
    'discloses %s',
    (_name, pattern) => {
      expect(committedStudy().markdown).toMatch(pattern);
    },
    STUDY_TIMEOUT_MS,
  );

  it(
    'never calls the examined period untouched',
    () => {
      const { markdown } = committedStudy();
      expect(markdown.length).toBeGreaterThan(0);
      expect(markdown).not.toMatch(/untouched/i);
    },
    STUDY_TIMEOUT_MS,
  );
});
