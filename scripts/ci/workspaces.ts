import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const readWorkspacePatterns = (root: string): string[] => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: unknown;
  };
  if (
    !Array.isArray(manifest.workspaces) ||
    !manifest.workspaces.every((item) => typeof item === 'string')
  ) {
    throw new Error('root package.json workspaces must be an array of strings');
  }
  return manifest.workspaces;
};

const resolveInsideRoot = (root: string, pattern: string): string => {
  const path = resolve(root, pattern);
  const fromRoot = relative(root, path);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith('../')) {
    throw new Error(`unsupported workspace pattern: ${pattern}`);
  }
  return path;
};

export const discoverWorkspaceRoots = (root: string): string[] => {
  const workspaces = new Set<string>();
  for (const pattern of readWorkspacePatterns(root)) {
    const isTrailingWildcard = pattern.endsWith('/*');
    const basePattern = isTrailingWildcard ? pattern.slice(0, -2) : pattern;
    if (basePattern.length === 0 || basePattern.includes('\\') || /[*?[\]{}]/.test(basePattern)) {
      throw new Error(`unsupported workspace pattern: ${pattern}`);
    }

    const base = resolveInsideRoot(root, basePattern);
    if (isTrailingWildcard) {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        const workspace = join(base, entry.name);
        if (entry.isDirectory() && existsSync(join(workspace, 'package.json'))) {
          workspaces.add(workspace);
        }
      }
      continue;
    }

    if (!existsSync(join(base, 'package.json'))) {
      throw new Error(`declared workspace has no package.json: ${pattern}`);
    }
    workspaces.add(base);
  }
  return [...workspaces].sort();
};
