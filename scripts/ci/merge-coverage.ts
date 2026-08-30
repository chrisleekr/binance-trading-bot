import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { discoverWorkspaceRoots } from './workspaces.ts';

interface ActiveCoveragePolicy {
  readonly lane: string;
}

type CoveragePolicyEntry =
  ActiveCoveragePolicy | { readonly exemption: string; readonly lane?: string };

export interface MergeCoverageOptions {
  readonly root: string;
  readonly policy: Readonly<Record<string, CoveragePolicyEntry>>;
  readonly inputs?: readonly string[];
}

const COVERAGE_LANES = new Set(['unit', 'integration', 'worker-integration', 'db-isolation']);

const comparePaths = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const walk = (dir: string, output: string[]): void => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, output);
    else if (entry.name === 'lcov.info') output.push(path);
  }
};

// Registered with no-blind-walk as a walk library rather than a walk gate: this listing is not a verdict either, and the root is again a parameter. A lane that goes dark here does not quietly lower a threshold, because `mergeCoverage` below refuses the merge outright at `missing complete-suite lcov for:` and `no lcov source records found`.
export const discoverCoverageInputs = (root: string): string[] => {
  const inputs: string[] = [];
  for (const workspace of discoverWorkspaceRoots(root)) {
    walk(join(workspace, 'coverage'), inputs);
  }
  return inputs
    .filter((path) => {
      const parts = path.split(sep);
      const coverageIndex = parts.lastIndexOf('coverage');
      return coverageIndex >= 0 && COVERAGE_LANES.has(parts[coverageIndex + 1] ?? '');
    })
    .sort(comparePaths);
};

export const mergeCoverage = ({
  root,
  policy,
  inputs = discoverCoverageInputs(root),
}: MergeCoverageOptions): { lcov: string; sourceCount: number; workspaceCount: number } => {
  const records = new Map<string, string>();
  const coveredPackages = new Set<string>();

  for (const input of [...inputs].sort(comparePaths)) {
    const lane = input.split(sep).at(-2);
    const workspaceRoot = resolve(dirname(input), '../..');
    const manifest = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8')) as {
      name: string;
    };
    const entry = policy[manifest.name];
    if (!entry || 'exemption' in entry || entry.lane !== lane) continue;

    let sourceCount = 0;
    for (const record of readFileSync(input, 'utf8').split('end_of_record')) {
      const source = /^SF:(.+)$/m.exec(record)?.[1];
      if (!source) continue;
      const repoSource = relative(root, resolve(workspaceRoot, source)).split(sep).join('/');
      if (records.has(repoSource)) throw new Error(`duplicate lcov source ${repoSource}`);
      records.set(repoSource, record.replace(/^SF:.+$/m, `SF:${repoSource}`).trim());
      sourceCount += 1;
    }
    if (sourceCount > 0) coveredPackages.add(manifest.name);
  }

  const requiredPackages = Object.entries(policy)
    .filter(([, entry]) => !('exemption' in entry))
    .map(([packageName]) => packageName);
  const missing = requiredPackages.filter((packageName) => !coveredPackages.has(packageName));
  if (missing.length > 0) {
    throw new Error(`missing complete-suite lcov for: ${missing.join(', ')}`);
  }
  if (records.size === 0) throw new Error('no lcov source records found');

  const lcov = [...records.entries()]
    .sort(([a], [b]) => comparePaths(a, b))
    .map(([, record]) => `${record}\nend_of_record\n`)
    .join('');
  return { lcov, sourceCount: records.size, workspaceCount: coveredPackages.size };
};

export const writeMergedCoverage = (
  options: MergeCoverageOptions,
): ReturnType<typeof mergeCoverage> => {
  const result = mergeCoverage(options);
  const output = join(options.root, 'coverage/lcov.info');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result.lcov);
  return result;
};
