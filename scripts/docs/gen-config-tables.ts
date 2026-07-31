#!/usr/bin/env bun
/**
 * Generate the docs config-table partials from the live zod config schemas.
 *
 * Docs labels/help derive from the SAME pipeline the web AutoForm renders with
 * (`buildFormFieldsFromJsonSchema` + `titleCase`/`LABEL_OVERRIDES` + the zod
 * `.describe()` strings), so a config table in the docs can never drift from
 * the UI. Output partials are committed under `docs/_generated/config/` and
 * included into narrative pages with `--8<--`; a CI gate (`--check`) fails the
 * build when a committed partial no longer matches the schema.
 *
 * The "when to change it" and "what to expect" columns are judgement the schema
 * cannot express, so they live in `config-notes/` keyed by field path. Those
 * keys are checked against the leaves the renderer actually emitted: a new
 * config field with no note, or a note for a field that no longer exists, fails
 * here rather than shipping a half-documented table.
 *
 * The pure render core (`renderSchemaWithPaths`/`stripEnabled`/`BANNER`) lives
 * in `@app/contracts` (`config-doc.ts`) so it is unit-testable; this file is the
 * impure shell: schema wiring, notes, fs, argv, and the vacuity floor.
 *
 * Run: `bun run docs:gen`  ·  Check: `bun run docs:gen --check`
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toConfigJsonSchema,
  RiskConfigSchema,
  DiscoveryConfigSchema,
  renderSchemaWithPaths,
  stripEnabled,
  BANNER,
  cell,
  type FieldNotes,
} from '@app/contracts';
import { ENV_CATALOGUE, type EnvVar } from '@app/core/env';
import { buildStrategyRegistry } from '@app/strategy-registry';
import { buildNotifyRegistry } from '@app/notify';

import { discoveryNotes } from './config-notes/discovery.js';
import { momentumNotes } from './config-notes/momentum.js';
import { notifierNotes } from './config-notes/notifiers.js';
import { rebalanceNotes } from './config-notes/rebalance.js';
import { riskNotes } from './config-notes/risk.js';
import { trailingTradeNotes } from './config-notes/trailing-trade.js';

/** Notes by strategy plugin name; a strategy with no entry fails the gate below. */
const STRATEGY_NOTES: Record<string, FieldNotes> = {
  'trailing-trade': trailingTradeNotes,
  momentum: momentumNotes,
  rebalance: rebalanceNotes,
};

/** Every missing or orphaned note, as human-readable lines. */
const noteGaps = (label: string, paths: readonly string[], notes: FieldNotes): string[] => {
  const emitted = new Set(paths);
  const gaps: string[] = [];
  for (const p of paths) {
    if (!notes[p]) gaps.push(`${label}: field \`${p}\` has no entry in config-notes/`);
  }
  for (const k of Object.keys(notes)) {
    if (!emitted.has(k))
      gaps.push(`${label}: note \`${k}\` refers to a field the schema no longer has`);
  }
  return gaps;
};

const ENV_HEAD =
  '| Variable | What it is | Values | Default | When to set it | What to expect |\n' +
  '| --- | --- | --- | --- | --- | --- |\n';

/**
 * Render the env-var reference from the catalogue, one table per group in
 * catalogue order. The default column shows `_required_` for a variable with no
 * default, so "boot fails without this" is visible at a glance rather than
 * buried in prose.
 */
const renderEnv = (): string => {
  const groups = new Map<string, [string, EnvVar][]>();
  for (const [name, v] of Object.entries(ENV_CATALOGUE)) {
    const rows = groups.get(v.group) ?? [];
    rows.push([name, v]);
    groups.set(v.group, rows);
  }
  let out = `${BANNER}\n\n`;
  for (const [group, rows] of groups) {
    out += `## ${group}\n\n${ENV_HEAD}`;
    out += rows
      .map(([name, v]) => {
        const def = v.def === null ? '_required_' : v.def === '' ? '`""`' : `\`${v.def}\``;
        const note = v.defNote ? ` — ${cell(v.defNote)}` : '';
        return `| \`${name}\` | ${cell(v.description)} | ${cell(v.values)} | ${def}${note} | ${cell(v.when)} | ${cell(v.expect)} |`;
      })
      .join('\n');
    out += '\n\n';
  }
  return out;
};

/**
 * Every catalogue entry missing operator guidance, plus every `.env.example` key
 * the catalogue does not document.
 *
 * The completeness direction is "declared ⇒ catalogued", which is what the
 * retired `no-undocumented-env-var.sh` checked against the rendered page. It is
 * asserted here instead, and more strictly: that gate only required the key to
 * appear *somewhere* in the doc text, so a key mentioned in prose satisfied it
 * with no row of its own. No reverse check — the catalogue legitimately
 * documents variables `.env.example` does not declare (optional and
 * image-injected ones).
 */
const envGaps = (repoRoot: string): string[] => {
  const gaps: string[] = [];
  for (const [name, v] of Object.entries(ENV_CATALOGUE)) {
    for (const field of ['description', 'when', 'expect', 'values'] as const) {
      if (!v[field] || v[field].trim() === '') {
        gaps.push(`env: \`${name}\` has an empty \`${field}\``);
      }
    }
    // `defNote` is matched against `undefined` by every gate and both app
    // suites, but rendered on truthiness, so a blank one would vanish from the
    // table while still redirecting the assertion away from `def`.
    if (v.defNote !== undefined && v.defNote.trim() === '') {
      gaps.push(`env: \`${name}\` has a blank \`defNote\``);
    }
    // `defNote` redirects the app env-docs assertion from `def` to `defParsed`
    // rather than dropping it. Without the second field there is nothing left to
    // assert, so a schema default could flip with every suite green.
    if (v.parsed && v.defNote !== undefined && !('defParsed' in v)) {
      gaps.push(
        `env: \`${name}\` has a \`defNote\` but no \`defParsed\` (state what an empty environment parses to, or \`null\` when the schema yields no value)`,
      );
    }
    // The other direction. Only a `defNote` on a variable an app actually
    // parses moves the assertion onto `defParsed`; anywhere else the field is
    // read by nothing and leaves its author believing they pinned a value they
    // had not.
    if ('defParsed' in v && (v.defNote === undefined || !v.parsed)) {
      gaps.push(
        `env: \`${name}\` has an inert \`defParsed\` (it takes effect only on a parsed variable whose \`defNote\` redirects the assertion onto it, so add that note, set \`parsed\`, or drop \`defParsed\`)`,
      );
    }
  }

  const examplePath = join(repoRoot, '.env.example');
  const declared = [
    ...new Set(
      readFileSync(examplePath, 'utf8')
        .split(/\r?\n/)
        .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
        .filter((k): k is string => k !== undefined),
    ),
  ];
  // A parser regression would silently make the check below vacuous, which is
  // worse than no check at all.
  if (declared.length === 0) {
    gaps.push('env: parsed no keys from .env.example — parser regression in this generator');
  }
  for (const key of declared) {
    if (!(key in ENV_CATALOGUE)) {
      gaps.push(`env: \`${key}\` is declared in .env.example but absent from ENV_CATALOGUE`);
    }
  }
  return gaps;
};

const main = (): void => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const OUT_DIR = join(repoRoot, 'docs', '_generated', 'config');

  const partials: Record<string, string> = {};
  const gaps: string[] = [];

  /** Render one schema, accumulating any note gaps it exposes. */
  const render = (label: string, jsonSchema: unknown, notes: FieldNotes): string => {
    const { markdown, paths } = renderSchemaWithPaths(jsonSchema, notes);
    gaps.push(...noteGaps(label, paths, notes));
    return markdown;
  };

  for (const s of buildStrategyRegistry().list()) {
    const notes = STRATEGY_NOTES[s.name];
    if (!notes) {
      gaps.push(
        `${s.name}: no config-notes module — add scripts/docs/config-notes/${s.name}.ts and register it`,
      );
      continue;
    }
    partials[`${s.name}.md`] =
      `${BANNER}\n\n${render(s.name, toConfigJsonSchema(s.configSchema), notes)}`;
  }
  partials['risk.md'] =
    `${BANNER}\n\n${render('risk', toConfigJsonSchema(RiskConfigSchema), riskNotes)}`;
  partials['discovery.md'] =
    `${BANNER}\n\n${render('discovery', stripEnabled(toConfigJsonSchema(DiscoveryConfigSchema)), discoveryNotes)}`;

  // Notifier providers: describeAll() already serialises each configSchema to
  // draft-07 JSON Schema with the shared options. Secret fields are rendered as
  // write-once password inputs in the UI, so flag them here. Provider configs
  // are flat and share one note map, so coverage is asserted over the union of
  // every provider's fields rather than per provider.
  const providers = buildNotifyRegistry().describeAll();
  const notifierPaths: string[] = [];
  let body = `${BANNER}\n\n`;
  for (const p of providers) {
    body += `### ${p.displayName}\n\n`;
    if (p.secretFields.length) {
      body += `!!! note "Write-once secret"\n\n    ${p.secretFields
        .map((f) => `\`${f}\``)
        .join(', ')} is entered once and never shown back.\n\n`;
    }
    const { markdown, paths } = renderSchemaWithPaths(p.configSchema, notifierNotes);
    notifierPaths.push(...paths);
    body += `${markdown}\n`;
  }
  gaps.push(...noteGaps('notifiers', notifierPaths, notifierNotes));
  partials['notifiers.md'] = body;

  // Env vars: the catalogue in `@app/core/env` is the source. Its defaults are
  // pinned to the real zod schemas by env-docs tests in apps/api and
  // apps/worker, so a default cannot drift from this table with CI green.
  gaps.push(...envGaps(repoRoot));
  partials['env.md'] = renderEnv();

  if (gaps.length > 0) {
    console.error('config-table notes are incomplete:\n');
    for (const g of gaps) console.error(`  ${g}`);
    console.error(
      '\nEvery config field needs a "when to change it" and a "what to expect" in ' +
        'scripts/docs/config-notes/, and every env var needs an ENV_CATALOGUE entry in ' +
        '@app/core/env. See docs/contributing/coding-rules.md.',
    );
    process.exit(1);
  }

  // Vacuity guard: 3 shipped strategies + risk + discovery + notifiers + env.
  // Grows as strategies are added; a count below this means a schema import or
  // registry regression, and a drift gate that generates nothing must fail.
  const FLOOR = 7;
  if (Object.keys(partials).length < FLOOR) {
    console.error(
      `generated only ${Object.keys(partials).length} partial(s), expected >= ${FLOOR} — schema import or registry regression.`,
    );
    process.exit(1);
  }

  const check = process.argv.includes('--check');
  mkdirSync(OUT_DIR, { recursive: true });

  let stale = 0;
  for (const [name, content] of Object.entries(partials)) {
    const path = join(OUT_DIR, name);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (current === content) continue;
    if (check) {
      stale += 1;
      console.error(`stale: docs/_generated/config/${name}`);
    } else {
      writeFileSync(path, content);
      console.log(`wrote docs/_generated/config/${name}`);
    }
  }

  if (check && stale > 0) {
    console.error(
      `\n${stale} config-table partial(s) are stale. Run \`bun run docs:gen\` and commit the result.`,
    );
    process.exit(1);
  }
  if (check) console.log(`config tables up to date (${Object.keys(partials).length} partials).`);
};

if (import.meta.main) main();
