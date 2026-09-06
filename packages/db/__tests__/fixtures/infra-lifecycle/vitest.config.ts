import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const testcontainersSpecifier = ['@app', 'testcontainers'].join('/');
const globalSetup = join(root, '../../_global-setup.ts');
// Named here rather than spread conditionally: a renamed setup would otherwise degrade to "no global setup" and surface as `_infra.ts` refusing a missing URL, which reads as a defect in the code under test instead of a stale path in this fixture.
if (!existsSync(globalSetup)) throw new Error(`missing ${globalSetup}`);

export default defineConfig({
  root,
  resolve: {
    alias: {
      [testcontainersSpecifier]: join(root, 'testcontainers.fixture.ts'),
    },
  },
  test: {
    environment: 'node',
    fileParallelism: false,
    globalSetup,
    include: ['**/consumer-*.fixture.ts'],
    isolate: false,
    reporters: ['dot'],
  },
});
