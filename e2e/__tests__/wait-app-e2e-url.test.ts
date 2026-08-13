import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const READINESS = join(REPO_ROOT, 'scripts/ci/wait-app-e2e-url.ts');

describe('app-e2e readiness wait', () => {
  it('stops waiting immediately when the app process has exited', () => {
    const result = spawnSync(
      'bun',
      [READINESS, 'http://127.0.0.1:1/readyz', '2147483647', '5000'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exited before');
  });
});
