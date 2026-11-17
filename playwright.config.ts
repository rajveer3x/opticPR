import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    viewport: { width: 1440, height: 1080 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @opticpr/web dev --port 5174',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
  },
});
