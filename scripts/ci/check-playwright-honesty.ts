interface Annotation {
  readonly type?: string;
  readonly description?: string;
}

interface PlaywrightResult {
  readonly status?: string;
}

interface PlaywrightTest {
  readonly annotations?: readonly Annotation[];
  readonly projectName?: string;
  readonly results?: readonly PlaywrightResult[];
}

interface PlaywrightSpec {
  readonly file?: string;
  readonly title?: string;
  readonly tests?: readonly PlaywrightTest[];
}

const BOOTSTRAP_PROJECTS = [
  'chromium-mobile',
  'chromium-desktop',
  'firefox-desktop',
  'webkit-desktop',
] as const;

const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length);
const strictProjects = process.argv.includes('--strict-projects');
if (mode !== 'browser-bootstrap' && mode !== 'app-required') {
  console.error('playwright-honesty: expected --mode=browser-bootstrap or --mode=app-required');
  process.exit(2);
}

const report = (await Bun.stdin.json()) as unknown;
const reportRecord = report as {
  readonly config?: { readonly projects?: readonly { readonly name?: string }[] };
};
const specs: PlaywrightSpec[] = [];
const visit = (value: unknown): void => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visit(item);
    return;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record['specs'])) {
    for (const spec of record['specs']) specs.push(spec as PlaywrightSpec);
  }
  if (Array.isArray(record['suites'])) visit(record['suites']);
};
visit(report);

let executions = 0;
let skipped = 0;
const reasons = new Map<string, number>();
const successfulBootstrapProjects = new Set<string>();
const appExecutions = new Map<string, { count: number; passed: number }>();
const wrongAppSpecs = new Set<string>();
for (const spec of specs) {
  for (const test of spec.tests ?? []) {
    executions += 1;
    const status = test.results?.at(-1)?.status;
    if (mode === 'app-required') {
      const file = spec.file ?? '[missing file]';
      if (!/(^|[\\/])app-p0\.spec\.ts$/.test(file)) wrongAppSpecs.add(file);
      const project = test.projectName ?? '[missing project]';
      const current = appExecutions.get(project) ?? { count: 0, passed: 0 };
      appExecutions.set(project, {
        count: current.count + 1,
        passed: current.passed + (status === 'passed' ? 1 : 0),
      });
    }
    if (
      status === 'passed' &&
      /(^|[\\/])smoke\.spec\.ts$/.test(spec.file ?? '') &&
      test.projectName
    ) {
      successfulBootstrapProjects.add(test.projectName);
    }
    if (status !== 'skipped') continue;
    skipped += 1;
    const reason =
      test.annotations?.find((annotation) => annotation.type === 'skip')?.description?.trim() ||
      `no skip reason: ${spec.title ?? 'unnamed test'}`;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
}

if (executions === 0) {
  console.error('playwright-honesty: report contained no test executions');
  process.exit(1);
}

// Executable Playwright JSON reports declare their configured projects. The
// older synthetic contract fixture has no config metadata, so its count and
// skip assertions remain valid without pretending it is a complete report.
const configuredProjects = reportRecord.config?.projects?.map(({ name }) => name) ?? [];
if (strictProjects && configuredProjects.length === 0) {
  console.error('browser-bootstrap: strict report is missing config.projects metadata');
  process.exit(1);
}
if (mode === 'app-required' && configuredProjects.length === 0) {
  console.error('app-required: report is missing config.projects metadata');
  process.exit(1);
}
if (mode === 'app-required' && skipped > 0) {
  console.error(`app-required: ${skipped} skipped app executions are not allowed`);
  process.exit(1);
}
if (configuredProjects.length > 0) {
  const duplicateConfiguration = configuredProjects.filter(
    (name, index) => name && configuredProjects.indexOf(name) !== index,
  );
  const wrongConfiguration = configuredProjects.filter(
    (name) => name && !BOOTSTRAP_PROJECTS.includes(name as (typeof BOOTSTRAP_PROJECTS)[number]),
  );
  const missingConfiguration = BOOTSTRAP_PROJECTS.filter(
    (name) => !configuredProjects.includes(name),
  );
  if (
    wrongConfiguration.length > 0 ||
    missingConfiguration.length > 0 ||
    duplicateConfiguration.length > 0
  ) {
    console.error(
      `browser-bootstrap: configured projects differ, missing [${missingConfiguration.join(', ')}], unexpected [${wrongConfiguration.join(', ')}], duplicate [${duplicateConfiguration.join(', ')}]`,
    );
    process.exit(1);
  }

  if (mode === 'browser-bootstrap') {
    const missingBootstrap = BOOTSTRAP_PROJECTS.filter(
      (name) => !successfulBootstrapProjects.has(name),
    );
    if (missingBootstrap.length > 0) {
      console.error(
        `browser-bootstrap: missing successful bootstrap smoke for: ${missingBootstrap.join(', ')}`,
      );
      process.exit(1);
    }
  } else {
    const invalidAppProjects = BOOTSTRAP_PROJECTS.filter((name) => {
      const result = appExecutions.get(name);
      return result?.count !== 1 || result.passed !== 1;
    });
    const unexpectedAppProjects = [...appExecutions.keys()].filter(
      (name) => !BOOTSTRAP_PROJECTS.includes(name as (typeof BOOTSTRAP_PROJECTS)[number]),
    );
    if (wrongAppSpecs.size > 0) {
      console.error(`app-required: unexpected spec executions: ${[...wrongAppSpecs].join(', ')}`);
      process.exit(1);
    }
    if (invalidAppProjects.length > 0 || unexpectedAppProjects.length > 0) {
      console.error(
        `app-required: expected exactly one passed app-p0 execution per project; invalid [${invalidAppProjects.join(', ')}], unexpected [${unexpectedAppProjects.join(', ')}]`,
      );
      process.exit(1);
    }
  }
}

console.log(`${mode}: ${executions} executions, ${skipped} skipped`);
for (const [reason, count] of [...reasons.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${count} skipped: ${reason}`);
}
