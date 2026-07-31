import { execSync } from 'node:child_process';

/**
 * Resolve the running build's git short SHA for the operator status surface.
 *
 * Called once at process boot, never on a hot path. The production alpine
 * runtime image carries no git binary, so the `git rev-parse` fallback is
 * expected to throw there; the deploy injects the real SHA via `GIT_SHA`
 * (Docker build-arg) and this function returns that. The git fallback exists
 * only for local/dev boots where the build-arg is absent but a `.git` is
 * present. When neither is available the SHA degrades to `'unknown'` rather
 * than crashing boot — a missing SHA is a status-panel cosmetic, not a fault.
 */
export const resolveGitSha = (envValue?: string): string => {
  const trimmed = envValue?.trim();
  if (trimmed) return trimmed;
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};
