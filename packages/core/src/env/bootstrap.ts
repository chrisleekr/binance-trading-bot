import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findEnvFile, findRepoRoot, loadEnvFile } from './load-env.js';

/**
 * Process env bootstrap for app entrypoints. Walks up from the
 * calling module's location to find the workspace-root `.env`
 * (bounded by `.git` or `turbo.json`) and merges its entries into
 * `process.env`, leaving already-set vars untouched.
 *
 * Container-safe by design: production container images ship neither
 * `.git` nor `turbo.json`, so `findRepoRoot` returns `undefined` and
 * this function is a no-op. Compose's `environment:` injection
 * populates `process.env` before Bun starts; the app-level zod loader
 * sees the populated env regardless of how it got there.
 *
 * Call once, before any import that reads `process.env` at module
 * load time.
 */
export const bootstrapEnv = (importMetaUrl: string): void => {
  const scriptDir = dirname(fileURLToPath(importMetaUrl));
  const repoRoot = findRepoRoot(scriptDir);
  if (repoRoot === undefined) return;
  const envPath = findEnvFile(scriptDir, repoRoot);
  if (envPath !== undefined) loadEnvFile(envPath);
};
