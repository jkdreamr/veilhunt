import { defineConfig } from '@playwright/test';

// WebGL games must run on a real GPU-backed Chromium (channel: 'chromium'), not
// the default headless shell which silently falls back to SwiftShader, and with
// a single worker so parallel contexts do not contend for the GPU.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'artifacts/playwright-report' }]],
  outputDir: 'artifacts/test-results',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    channel: 'chromium',
    headless: true,
    launchOptions: {
      args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--mute-audio'],
    },
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4173/health',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
