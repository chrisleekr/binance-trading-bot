import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = defineConfig({
  testDir: './tests',
  testMatch: 'app-p0.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/app-results.json' }]],
  use: {
    baseURL: 'http://localhost:53000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: { ...devices['Pixel 5'], viewport: { width: 375, height: 667 } },
    },
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'firefox-desktop',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'webkit-desktop',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 720 } },
    },
  ],
});

export default config;
