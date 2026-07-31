import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

import { coverageThresholdsFor } from '../../packages/config/vitest/index.js';

// Fail loud if web is ever dropped from the shared map rather than silently
// collecting coverage with no gate (the #488 dead-gate failure mode this wiring
// exists to prevent).
const webCoverageThresholds = coverageThresholdsFor('@app/web');
if (!webCoverageThresholds) {
  throw new Error('@app/web missing from PER_PACKAGE_THRESHOLDS — its coverage gate would be dead');
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `virtual:pwa-register` only exists during a real vite build; point it
      // at a stub so the test resolver succeeds (tests `vi.mock` it anyway).
      'virtual:pwa-register': fileURLToPath(
        new URL('./__tests__/stubs/virtual-pwa-register.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./__tests__/setup.ts'],
    css: false,
    include: ['__tests__/**/*.test.{ts,tsx}'],
    // CI's shared runner oversubscribes CPU across the parallel web suite, so
    // multi-step interaction tests (a wizard chaining several click/type calls,
    // each waiting on a starved render) can crest vitest's 5s default. Lifted to
    // 20 s, above the 10 s RTL asyncUtilTimeout in ./__tests__/setup.ts, so a
    // slow wait fails on its own assertion rather than a test-level timeout.
    // Timeouts only bite on failure, so this costs nothing on a green run.
    testTimeout: 20_000,
    server: {
      deps: {
        // Inline workspace packages and zod so vite SSR transforms them
        // consistently across darwin (host) and alpine (CI). Without this,
        // CI's native ESM resolver fails to expose `z` from zod when
        // @app/contracts/src/errors.ts is loaded transitively.
        inline: [/^@app\//, 'zod'],
      },
    },
    // web has no DB-gated tests, so its coverage is fully achievable in the
    // no-DB unit job. Thresholds sourced from the shared map (the single source
    // of truth); this custom config can't call defineProject, so it wires them
    // by hand. The coverage-thresholds guard test asserts this stays live.
    reporters: ['default', ['junit', { outputFile: 'test-results/junit.xml' }]],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: webCoverageThresholds,
    },
  },
});
