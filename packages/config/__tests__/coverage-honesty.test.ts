import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defineProject, PER_PACKAGE_THRESHOLDS } from '../vitest/index.js';
import web from '../../../apps/web/vitest.config.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCE_INCLUDE = ['src/**/*.{ts,tsx}'];
const COVERAGE_LANES = {
  unit: 'scripts/ci/test-unit.sh',
  integration: 'scripts/ci/test-integration.sh',
  'worker-integration': 'scripts/ci/test-worker-integration.sh',
  'db-isolation': 'scripts/ci/test-db-isolation.sh',
} as const;

type CoverageLane = keyof typeof COVERAGE_LANES;
type Thresholds = { readonly lines: number; readonly branches: number };
type CoveragePolicyEntry =
  | {
      readonly lane: CoverageLane;
      readonly include: readonly string[];
      readonly thresholds: Thresholds;
    }
  | { readonly exemption: string };

const readRepoFile = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8');

const yamlBlock = (source: string, key: string, indentation: number): string => {
  const prefix = ' '.repeat(indentation);
  const start = new RegExp(`^${prefix}${key}:\\s*$`, 'm').exec(source);
  expect(start, `missing ${key} job`).not.toBeNull();
  const tail = source.slice(start!.index + start![0].length);
  const next = new RegExp(`^${prefix}[^ #\\s][^:]*:\\s*$`, 'm').exec(tail);
  return next ? tail.slice(0, next.index) : tail;
};

const walkFiles = (root: string, accept: (path: string) => boolean): string[] => {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, accept));
    else if (accept(path)) files.push(path);
  }
  return files;
};

const workspacePackages = (): Map<string, string> => {
  const manifests = [
    ...walkFiles(join(REPO_ROOT, 'apps'), (path) => basename(path) === 'package.json'),
    ...walkFiles(join(REPO_ROOT, 'packages'), (path) => basename(path) === 'package.json'),
    join(REPO_ROOT, 'e2e/package.json'),
  ];
  const packages = new Map<string, string>();
  for (const manifest of manifests) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
    expect(parsed.name, `${relative(REPO_ROOT, manifest)} has no package name`).toBeTypeOf(
      'string',
    );
    expect(packages.has(parsed.name!), `duplicate workspace name ${parsed.name}`).toBe(false);
    packages.set(parsed.name!, relative(REPO_ROOT, manifest));
  }
  return packages;
};

const loadCoveragePolicy = async (): Promise<Record<string, CoveragePolicyEntry>> => {
  const path = join(REPO_ROOT, 'packages/config/vitest/coverage-policy.js');
  expect(existsSync(path), 'the exhaustive coverage policy module is absent').toBe(true);
  const module = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as {
    COVERAGE_POLICY?: Record<string, CoveragePolicyEntry>;
  };
  expect(module.COVERAGE_POLICY, 'coverage-policy.js must export COVERAGE_POLICY').toBeTypeOf(
    'object',
  );
  return module.COVERAGE_POLICY!;
};

describe('honest source denominator', () => {
  it('counts every shared-project and web src TypeScript file whether imported or not', () => {
    const shared = defineProject() as {
      test?: { coverage?: { include?: readonly string[] } };
    };
    const webConfig = web as { test?: { coverage?: { include?: readonly string[] } } };

    expect(shared.test?.coverage?.include).toEqual(SOURCE_INCLUDE);
    expect(webConfig.test?.coverage?.include).toEqual(SOURCE_INCLUDE);
  });
});

describe('coverage policy completeness', () => {
  it('accounts for every workspace with a live complete-suite gate or a factual exemption', async () => {
    const packages = workspacePackages();
    const policy = await loadCoveragePolicy();

    expect([...Object.keys(policy)].sort()).toEqual([...packages.keys()].sort());
    expect(packages.size, 'workspace discovery must not pass vacuously').toBeGreaterThan(0);

    for (const [packageName, entry] of Object.entries(policy)) {
      if ('exemption' in entry) {
        expect(
          entry.exemption.trim().length,
          `${packageName} has a vague exemption`,
        ).toBeGreaterThan(20);
        expect(PER_PACKAGE_THRESHOLDS).not.toHaveProperty(packageName);
        continue;
      }

      expect(entry.include, `${packageName} narrows the shared denominator`).toEqual(
        SOURCE_INCLUDE,
      );
      expect(entry.thresholds.lines, `${packageName} has no line floor`).toBeGreaterThan(0);
      expect(entry.thresholds.branches, `${packageName} has no branch floor`).toBeGreaterThan(0);
      expect(
        entry.thresholds.lines,
        `${packageName} has an invalid line floor`,
      ).toBeLessThanOrEqual(100);
      expect(
        entry.thresholds.branches,
        `${packageName} has an invalid branch floor`,
      ).toBeLessThanOrEqual(100);
      expect(PER_PACKAGE_THRESHOLDS[packageName], `${packageName} threshold is not live`).toEqual(
        entry.thresholds,
      );
    }
  });

  it('binds infrastructure-backed packages to the lane that runs their complete suite', async () => {
    const policy = await loadCoveragePolicy();
    const expected: Record<string, CoverageLane> = {
      '@app/api': 'integration',
      '@app/testcontainers': 'integration',
      '@app/worker': 'worker-integration',
      '@app/db': 'db-isolation',
    };

    for (const [packageName, lane] of Object.entries(expected)) {
      const entry = policy[packageName];
      expect(entry, `${packageName} is absent from the coverage policy`).toBeDefined();
      expect(entry && 'lane' in entry ? entry.lane : undefined).toBe(lane);
    }
    for (const [packageName, entry] of Object.entries(policy)) {
      if ('lane' in entry && !(packageName in expected)) {
        expect(entry.lane, `${packageName} is not complete in ${entry.lane}`).toBe('unit');
      }
    }
  });
});

describe('coverage artifact fan-in', () => {
  it('collects collision-free artifacts from all four complete-suite lanes', () => {
    for (const [lane, scriptPath] of Object.entries(COVERAGE_LANES)) {
      const script = readRepoFile(scriptPath);
      expect(script, `${lane} does not collect coverage`).toMatch(/--coverage(?:\s|$)/);
      expect(script, `${lane} does not declare a lane-specific artifact destination`).toMatch(
        new RegExp(`(?:COVERAGE_LANE\\s*=\\s*['"]?${lane}|coverage[/_.-]${lane})`),
      );
    }

    const turbo = JSON.parse(readRepoFile('turbo.json')) as {
      tasks?: { test?: { outputs?: string[] } };
    };
    expect(turbo.tasks?.test?.outputs).toContain('coverage/**');
  });

  it('deterministically merges and retains lcov evidence in GitLab and GitHub', () => {
    const mergeScript = 'scripts/ci/merge-coverage.sh';
    expect(
      existsSync(join(REPO_ROOT, mergeScript)),
      'the deterministic merge script is absent',
    ).toBe(true);

    const gitlab = readRepoFile('.gitlab-ci.yml');
    const github = readRepoFile('.github/workflows/ci.yml');
    const mergeJobs = [
      yamlBlock(gitlab, 'coverage-merge', 0),
      yamlBlock(github, 'coverage-merge', 2),
    ];
    for (const job of mergeJobs) {
      expect(job).toContain(mergeScript);
      expect(job).toMatch(/lcov\.info/);
      expect(job).toMatch(/needs\s*:/);
      for (const lane of Object.keys(COVERAGE_LANES)) expect(job).toContain(lane);
    }
    expect(mergeJobs[0]).toMatch(/artifacts\s*:/);
    expect(mergeJobs[1]).toMatch(/actions\/download-artifact@/);
    expect(mergeJobs[1]).toMatch(/actions\/upload-artifact@/);

    for (const lane of Object.keys(COVERAGE_LANES)) {
      expect(yamlBlock(gitlab, lane, 0)).toMatch(/artifacts\s*:[\s\S]*coverage\//);
      expect(yamlBlock(github, lane === 'unit' ? 'unit' : lane, 2)).toMatch(
        /actions\/upload-artifact@/,
      );
    }
  });
});

describe('v8 ignore triage', () => {
  it('keeps every retained ignore region paired and narrowly justified', () => {
    const sourceFiles = [
      ...walkFiles(join(REPO_ROOT, 'apps'), (path) => /\/src\/.*\.(?:[cm]?js|tsx?)$/.test(path)),
      ...walkFiles(join(REPO_ROOT, 'packages'), (path) =>
        /\/src\/.*\.(?:[cm]?js|tsx?)$/.test(path),
      ),
    ];
    expect(sourceFiles.length, 'ignore triage scanned no source files').toBeGreaterThan(0);

    const directive = /\/\*\s*v8\s+ignore\s+(start|stop|next(?:\s+\d+)?)\b([\s\S]*?)\*\//g;
    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      let openRegions = 0;
      for (const match of source.matchAll(directive)) {
        const kind = match[1]!;
        if (kind === 'stop') {
          openRegions -= 1;
          expect(openRegions, `${relative(REPO_ROOT, file)} has an unmatched ignore stop`).toBe(0);
          continue;
        }

        const reason = match[2]?.match(/--\s*reason:\s*(.+)/s)?.[1]?.trim() ?? '';
        expect(
          reason.length,
          `${relative(REPO_ROOT, file)} has an untriaged ${kind}`,
        ).toBeGreaterThan(20);
        if (kind === 'start') {
          expect(openRegions, `${relative(REPO_ROOT, file)} nests ignore regions`).toBe(0);
          openRegions += 1;
        }
      }
      expect(openRegions, `${relative(REPO_ROOT, file)} has an unterminated ignore region`).toBe(0);
    }
  });
});

describe('truthful Playwright lanes', () => {
  it('labels the stack-free lane as browser bootstrap and uses the current same-origin port', () => {
    const script = readRepoFile('scripts/ci/test-e2e.sh');
    const config = readRepoFile('e2e/playwright.config.ts');
    const gitlab = readRepoFile('.gitlab-ci.yml');
    const github = readRepoFile('.github/workflows/ci.yml');

    expect(script).toMatch(/browser[- ]bootstrap/i);
    expect(gitlab).toMatch(/^browser-bootstrap\s*:/m);
    expect(github).toMatch(/name:\s*browser-bootstrap\b/);
    expect(config).toContain('http://localhost:53000');
    expect(config).not.toContain('http://localhost:55173');
    expect(script).toContain('check-playwright-honesty.ts');
    expect(`${script}\n${config}`).toMatch(/\bjson\b/i);
  });

  it('reports stack-free skips and rejects skipped app tests when the app lane is required', () => {
    const checker = join(REPO_ROOT, 'scripts/ci/check-playwright-honesty.ts');
    expect(existsSync(checker), 'the executable Playwright honesty check is absent').toBe(true);

    const report = {
      config: {
        projects: ['chromium-mobile', 'chromium-desktop', 'firefox-desktop', 'webkit-desktop'].map(
          (name) => ({ name }),
        ),
      },
      suites: [
        {
          specs: [
            {
              file: 'tests/smoke.spec.ts',
              title: 'browser boots',
              tests: [
                'chromium-mobile',
                'chromium-desktop',
                'firefox-desktop',
                'webkit-desktop',
              ].map((projectName) => ({ projectName, results: [{ status: 'passed' }] })),
            },
            {
              file: 'tests/login-smoke.spec.ts',
              title: 'application login',
              tests: [
                {
                  projectName: 'chromium',
                  annotations: [{ type: 'skip', description: 'requires the full stack' }],
                  results: [{ status: 'skipped' }],
                },
              ],
            },
          ],
        },
      ],
    };
    const input = JSON.stringify(report);
    const bootstrap = spawnSync('bun', [checker, '--mode=browser-bootstrap'], {
      cwd: REPO_ROOT,
      input,
      encoding: 'utf8',
    });
    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    expect(bootstrap.stdout).toMatch(/browser[- ]bootstrap/i);
    expect(bootstrap.stdout).toMatch(/1\s+skipped/i);
    expect(bootstrap.stdout).toContain('requires the full stack');

    const required = spawnSync('bun', [checker, '--mode=app-required'], {
      cwd: REPO_ROOT,
      input,
      encoding: 'utf8',
    });
    expect(required.status).not.toBe(0);
    expect(`${required.stdout}\n${required.stderr}`).toMatch(/skipped/i);
  });
});

describe('Codecov claims', () => {
  it('documents the human prerequisite without publishing an inactive status claim', () => {
    const workflowText = `${readRepoFile('.gitlab-ci.yml')}\n${readRepoFile(
      '.github/workflows/ci.yml',
    )}`;
    const docs = [
      join(REPO_ROOT, 'README.md'),
      ...walkFiles(join(REPO_ROOT, 'docs'), (path) => path.endsWith('.md')),
    ].map((path) => readFileSync(path, 'utf8'));
    const docsText = docs.join('\n');
    const hasLiveIntegration = /codecov\/codecov-action|\bcodecov\s+upload\b/i.test(workflowText);
    const publishesStatusBadge = /codecov\.io\/(?:gh|gl)\/[^\s)]+\/(?:badge|graph\/badge)/i.test(
      docsText,
    );

    expect(docs.length, 'Codecov claim scan read no documentation').toBeGreaterThan(0);
    expect(/CODECOV_TOKEN/i.test(docsText), 'docs omit the Codecov credential prerequisite').toBe(
      true,
    );
    expect(
      /CODECOV_TOKEN[\s\S]{0,300}(?:not (?:configured|available)|must be|requires?|prerequisite|provision)/i.test(
        docsText,
      ),
      'docs do not explain that Codecov activation is human-owned',
    ).toBe(true);
    if (!hasLiveIntegration) expect(publishesStatusBadge).toBe(false);
  });
});
