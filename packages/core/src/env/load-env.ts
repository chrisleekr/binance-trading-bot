import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Walk up from `startDir` looking for a directory that contains a
 * repository-root marker (`.git` works for both standard checkouts
 * and worktrees, where `.git` is a regular file; `turbo.json` is a
 * monorepo-root fallback). Returns the absolute path of the first
 * matching ancestor, or `undefined` if none is found within 12
 * levels.
 *
 * Why bounded: the `.env` lookup that uses this helper must stay
 * inside the project checkout to avoid silently picking up the
 * operator's home `~/.env` and pointing migrations at the wrong
 * database. Container images ship neither marker, so this returns
 * `undefined` there by design.
 */
export const findRepoRoot = (startDir: string): string | undefined => {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'turbo.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
};

/**
 * Walk up from `startDir` looking for a `.env` file, stopping after
 * inspecting `stopDir` (the bounded ancestor). Returns the first
 * absolute path found, or `undefined`. Pass `stopDir = repoRoot` to
 * keep the search inside the project checkout.
 *
 * Why: Bun's built-in `.env` autoload only scans `cwd`, so a script
 * invoked from inside `packages/<x>/` or `apps/<x>/` (as turbo does)
 * misses the workspace-root `.env`. This helper locates the file
 * regardless of where the script chain began.
 */
export const findEnvFile = (startDir: string, stopDir?: string): string | undefined => {
  let dir = resolve(startDir);
  const stop = stopDir !== undefined ? resolve(stopDir) : undefined;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    if (stop !== undefined && dir === stop) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
};

/**
 * Parse a `.env`-style file body into a key/value map. Lines that are
 * blank or begin with `#` are skipped; the first `=` separates key
 * and value; surrounding single or double quotes are stripped; a
 * trailing `\r` is removed so Windows-edited files parse cleanly.
 *
 * Why: Bun 1.3.x does not expose `process.loadEnvFile`, so this ships
 * its own minimal parser instead of pulling in a dependency for one
 * consumer. The repo's `.env.example` uses the basic `KEY=value`
 * form this parser supports; anything richer (multi-line values,
 * variable expansion) is intentionally out of scope.
 */
export const parseEnvFile = (content: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === '') continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
};

/**
 * Read a `.env` file at `path` and merge its entries into
 * `process.env`, leaving pre-existing variables untouched. Existing
 * shell exports therefore keep precedence over file defaults,
 * matching the convention used by `dotenv` and Bun's own autoloader.
 */
export const loadEnvFile = (path: string): void => {
  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
};
