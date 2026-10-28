import { existsSync } from "node:fs";

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: ".local/browser-results",
  use: {
    baseURL: process.env.RIFTER_BASE_URL || "http://localhost:5173",
    // API writes require an Origin header (integrations/openrift/api/routes.ts).
    extraHTTPHeaders: { Origin: process.env.RIFTER_BASE_URL || "http://localhost:5173" },
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      args: ["--no-sandbox"],
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
