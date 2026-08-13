import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHECKER = join(REPO_ROOT, 'scripts/ci/check-playwright-honesty.ts');
const PROJECTS = [
  'chromium-mobile',
  'chromium-desktop',
  'firefox-desktop',
  'webkit-desktop',
] as const;

const reportFor = (
  successfulProjects: readonly string[],
  configuredProjects: readonly string[] = PROJECTS,
): object => ({
  config: { projects: configuredProjects.map((name) => ({ name })) },
  suites: [
    {
      specs: [
        {
          file: 'smoke.spec.ts',
          title: 'browser starts',
          tests: successfulProjects.map((projectName) => ({
            projectName,
            results: [{ status: 'passed' }],
          })),
        },
      ],
    },
  ],
});

const check = (report: object, strict = false) =>
  spawnSync(
    'bun',
    [CHECKER, '--mode=browser-bootstrap', ...(strict ? ['--strict-projects'] : [])],
    {
      cwd: REPO_ROOT,
      input: JSON.stringify(report),
      encoding: 'utf8',
    },
  );

const checkApp = (report: object) =>
  spawnSync('bun', [CHECKER, '--mode=app-required'], {
    cwd: REPO_ROOT,
    input: JSON.stringify(report),
    encoding: 'utf8',
  });

describe('Playwright browser-bootstrap project honesty', () => {
  it('accepts a successful smoke from every configured project', () => {
    const result = check(reportFor(PROJECTS));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('browser-bootstrap: 4 executions, 0 skipped');
  });

  it('rejects a missing configured project', () => {
    const result = check(reportFor(PROJECTS.slice(0, -1), PROJECTS.slice(0, -1)));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('configured projects differ, missing [webkit-desktop]');
  });

  it('rejects a configured project with no successful smoke', () => {
    const result = check(reportFor(PROJECTS.slice(0, -1)));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing successful bootstrap smoke for: webkit-desktop');
  });

  it('rejects missing project metadata in strict mode', () => {
    const report = reportFor(PROJECTS) as { config?: unknown };
    delete report.config;
    const result = check(report, true);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'browser-bootstrap: strict report is missing config.projects metadata',
    );
  });
});

describe('Playwright required-app project honesty', () => {
  it('accepts one successful app execution from every configured project', () => {
    const report = reportFor(PROJECTS) as {
      suites: { specs: { file: string }[] }[];
    };
    report.suites[0]!.specs[0]!.file = 'app-p0.spec.ts';

    const result = checkApp(report);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('app-required: 4 executions, 0 skipped');
  });

  it('rejects a configured project with no successful app execution', () => {
    const report = reportFor(PROJECTS.slice(0, -1)) as {
      suites: { specs: { file: string }[] }[];
    };
    report.suites[0]!.specs[0]!.file = 'app-p0.spec.ts';

    const result = checkApp(report);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid [webkit-desktop]');
  });

  it('rejects missing project metadata without a strict flag', () => {
    const report = reportFor(PROJECTS) as {
      config?: unknown;
      suites: { specs: { file: string }[] }[];
    };
    delete report.config;
    report.suites[0]!.specs[0]!.file = 'app-p0.spec.ts';

    const result = checkApp(report);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('app-required: report is missing config.projects metadata');
  });

  it('rejects a passing execution from a non-P0 spec', () => {
    const result = checkApp(reportFor(PROJECTS));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpected spec executions: smoke.spec.ts');
  });

  it('rejects duplicate, excess, and unexpected project executions', () => {
    const report = reportFor([...PROJECTS, 'chromium-mobile', 'other-browser']) as {
      suites: { specs: { file: string }[] }[];
    };
    report.suites[0]!.specs[0]!.file = 'app-p0.spec.ts';

    const result = checkApp(report);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid [chromium-mobile]');
    expect(result.stderr).toContain('unexpected [other-browser]');
  });
});
