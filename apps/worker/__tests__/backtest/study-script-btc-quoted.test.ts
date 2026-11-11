import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
// `symbolInfos` lists BTCUSDT first and the input carries a moving BTCUSDT series, so reading the quote from the first entry would divide BTC equity by that rate and still report `ok`.
const FIXTURE = join(ROOT, 'apps/worker/__tests__/fixtures/backtest-study/input-btc-quoted.jsonl');
// The study replays a real matrix from a subprocess, which a unit-test default would cut short.
const STUDY_TIMEOUT_MS = 120_000;
// Worked out by hand from the fixture path: ETHBTC fills 6.6 whole, LTCBTC fills 1 per candle for 25 candles, XRPBTC is refused, at open x 1.0002 x 1.0001 with a 10 bps fee.
const KNOWN_RETURN_PCT = 4.57058783924;
const KNOWN_DRAWDOWN_PCT = 3.717610612488809;

interface BtcResult {
  readonly status: string;
  readonly returnPct?: number;
  readonly maxDrawdownPct?: number;
}

interface Row {
  readonly name?: string;
  readonly costScenario?: string;
  readonly totalReturnPct?: number;
  readonly maxDrawdownPct?: number;
  readonly trades?: number;
  readonly allocations?: readonly unknown[];
  readonly btc?: BtcResult;
  readonly status?: string;
  readonly reason?: string;
}

interface Report {
  readonly fundingQuote: string;
  readonly configHashes: Readonly<Record<string, string>>;
  readonly controls: readonly Row[];
  readonly candidates: readonly Row[];
}

describe('backtest study on a BTC-quoted basket', () => {
  const temp = mkdtempSync(join(tmpdir(), 'backtest-study-btc-'));
  let report: Report;
  let markdown: string;

  beforeAll(() => {
    const json = join(temp, 'report.json');
    const md = join(temp, 'report.md');
    const out = spawnSync(
      'bun',
      ['scripts/backtest-study.ts', '--input', FIXTURE, '--out-json', json, '--out-md', md],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(out.status, out.stderr).toBe(0);
    report = JSON.parse(readFileSync(json, 'utf8')) as Report;
    markdown = readFileSync(md, 'utf8');
  }, STUDY_TIMEOUT_MS);

  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  const passive = (costScenario: string): Row => {
    const row = report.controls.find(
      (c) => c.name === 'passive-basket' && c.costScenario === costScenario,
    );
    if (!row) throw new Error(`no passive-basket row for ${costScenario}`);
    return row;
  };

  it('takes the funding quote from the traded symbols', () => {
    expect(report.fundingQuote).toBe('BTC');
  });

  it('reports the known BTC return and drawdown without converting', () => {
    expect(passive('base').btc).toEqual({
      status: 'ok',
      returnPct: KNOWN_RETURN_PCT,
      maxDrawdownPct: KNOWN_DRAWDOWN_PCT,
    });
  });

  it('keeps every BTC result equal to its quote-denominated result', () => {
    const rows = [...report.candidates, passive('base'), passive('stress')];
    expect(rows).toHaveLength(18);
    for (const row of rows) {
      expect(row.btc?.status).toBe('ok');
      expect(row.btc?.returnPct).toBe(row.totalReturnPct);
      // The engine signs a drawdown negative; the BTC column states its size.
      expect(row.btc?.maxDrawdownPct).toBe(Math.abs(row.maxDrawdownPct as number));
    }
  });

  it('does not fund the btc-hold control from the BTC balance', () => {
    const rows = report.controls.filter((c) => c.name === 'btc-hold');
    expect(rows.map((r) => r.costScenario)).toEqual(['base', 'stress']);
    for (const row of rows) {
      expect(row.status).toBe('not-applicable');
      expect(row.reason).toContain('funded in BTC');
      expect(row).not.toHaveProperty('totalReturnPct');
      expect(row).not.toHaveProperty('allocations');
      expect(row).not.toHaveProperty('btc');
    }
  });

  it('states the window in the Markdown report', () => {
    expect(markdown).toContain('## Window');
    expect(markdown).toContain('`1699999800000` to `1700001600000` ms');
    expect(markdown).toContain('Symbols: ETHBTC, LTCBTC, XRPBTC. Funding: 1 BTC.');
  });

  it('states the cost assumptions and volume cap in the Markdown report', () => {
    expect(markdown).toContain('## Cost assumptions');
    expect(markdown).toContain('| base | 10 | 2 | 2 |');
    expect(markdown).toContain('| stress | 10 | 10 | 10 |');
    expect(markdown).toContain("Volume cap: 1% of each detail candle's volume.");
  });

  it('locates and hashes each config in the Markdown report', () => {
    expect(markdown).toContain('## Configs');
    expect(Object.keys(report.configHashes).sort()).toEqual(['momentum', 'trailing-trade']);
    for (const [name, hash] of Object.entries(report.configHashes)) {
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
      expect(markdown).toContain(`| ${name} | \`configs["${name}"]\` | \`${hash}\` |`);
    }
  });

  it('lists the controls in the Markdown report', () => {
    expect(markdown).toContain('## Controls');
    for (const name of ['cash', 'zero-pct-btc', 'passive-basket']) {
      expect(markdown).toMatch(new RegExp(`^\\| ${name} \\|`, 'm'));
    }
    expect(markdown).toMatch(/^\| btc-hold \| base \|.*not applicable: /m);
  });

  it('shows filled, partial, rejected and unspent passive allocations', () => {
    expect(markdown).toContain('### Passive allocations');
    expect(markdown).toContain('| Control | Cost | Symbol | Budget | Spent | Unspent | Status |');
    expect(markdown).toContain(
      '| passive-basket | base | ETHBTC | 0.33 | 0.3300990066 | 0 | filled |',
    );
    expect(markdown).toContain(
      '| passive-basket | base | LTCBTC | 0.33 | 0.050015001 | 0.279984999 | partial |',
    );
    expect(markdown).toContain('| passive-basket | base | XRPBTC | 0.33 | 0 | 0.33 | rejected |');
  });
});
