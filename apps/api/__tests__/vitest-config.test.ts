// Guards the api package's vitest hookTimeout against silent regression.
//
// The api integration suites share one testcontainers Postgres+Redis stack,
// provisioned lazily on the first setupApp() (see _helpers.ts resolveInfra).
// On a cold Docker host that cold-start runs well past vitest's 10s default
// hookTimeout, so the first beforeAll times out while the container is still
// starting. The shared infraPromise has not settled yet, so every sibling
// suite awaiting it also hits its own 10s hook timeout — the whole package
// cascades with "Hook timed out in 10000ms". The full turbo `test` run hides
// this because the db package warms the container first; an isolated
// `--filter @app/api test` does not. Keep the hookTimeout comfortably above
// the cold container start so isolated runs stay reliable.

import { describe, expect, it } from 'vitest';

import config from '../vitest.config.js';

describe('@app/api vitest config', () => {
  it('sets a hookTimeout high enough to absorb the cold testcontainers start', () => {
    expect(config.test?.hookTimeout).toBeGreaterThanOrEqual(30_000);
  });

  it('registers the skip-banner global setup', () => {
    expect(config.test?.globalSetup).toEqual(['./__tests__/global-setup.ts']);
  });
});
