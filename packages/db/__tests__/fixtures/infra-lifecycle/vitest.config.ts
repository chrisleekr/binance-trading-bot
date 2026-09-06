import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const testcontainersSpecifier = ['@app', 'testcontainers'].join('/');
const globalSetup = join(root, '../../_global-setup.ts');

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
    ...(existsSync(globalSetup) && { globalSetup }),
    include: ['**/consumer-*.fixture.ts'],
    isolate: false,
    reporters: ['dot'],
  },
});
