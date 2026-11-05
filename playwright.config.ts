import { defineConfig } from "@playwright/test";
// Test accounts are confined to the test server. The production/preview admin
// configuration is never changed by the test process.
process.env.ADMIN_EMAILS = "qa-admin@inkastarna.invalid";
process.env.BETTER_AUTH_URL = "http://localhost:3100";
process.env.ADMIN_JOIN_CODE = "qa-only-admin-code-not-a-live-secret";
process.env.TEAM_JOIN_CODE = "qa-only-team-code-not-a-live-secret";
export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  reporter: process.env.CI ? "github" : "list",
  webServer: {
    command: "npm run start -- --port 3100",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
