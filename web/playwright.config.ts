/**
 * Browser tests (Chromium) against a real Silicon Accounts stack and the real Present service: they sign in through the
 * hosted pages (email codes come from the stack's mock sender) and use every page through the kit's API proxy.
 *
 *   setup             two Carbons sign in with an email code, once per run (e2e/accounts.setup.ts)
 *   pnpm test:e2e     public pages, sign-in, the proxy, refreshing, accessibility, and Present's own journeys
 *                     (e2e/pages*.spec.ts; the editor's own journeys are e2e/editor*.spec.ts)
 *   pnpm screens      PNGs of every page at 1440 and 390 wide, into screens/
 *
 * `next dev` starts here (on E2E_PORT, default 4330: the "web pages" lane of docs/architecture.md) unless it already
 * runs. The service (APP_API_URL, default the lane's 4331) and the converter must already run: start them from their
 * own READMEs. Settings come from the environment, then .env.local; APP_SECRET defaults to the present app's secret in
 * ../e2e/stack/test-stack.json (or TEST_STACK_JSON).
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "@playwright/test";

function dotenv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trimStart().startsWith("#")) out[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const local = dotenv(".env.local");
const pick = (name: string, fallback?: string) => process.env[name] || local[name] || fallback;

function appSecret(): string {
  const direct = pick("APP_SECRET");
  if (direct) return direct;
  const stack = process.env.TEST_STACK_JSON || "../e2e/stack/test-stack.json";
  if (stack && existsSync(stack)) {
    const secret = (JSON.parse(readFileSync(stack, "utf8")) as { apps?: Record<string, { app_secret?: string }> }).apps?.[pick("APP_ID", "present")!]?.app_secret;
    if (secret) return secret;
  }
  throw new Error("The browser tests need the app secret of the present app on the Accounts stack: set APP_SECRET (or put it in .env.local), or TEST_STACK_JSON=<path to test-stack.json>.");
}

// One session secret for the whole run: workers inherit it from the main process, so the tests can open the cookie.
const sessionSecret = process.env.E2E_SESSION_SECRET || pick("SESSION_SECRET") || randomBytes(48).toString("base64");
process.env.E2E_SESSION_SECRET = sessionSecret;

const PORT = Number(process.env.E2E_PORT || 4330);
const env = {
  APP_ID: pick("APP_ID", "present")!,
  APP_SECRET: appSecret(),
  ACCOUNTS_URL: pick("ACCOUNTS_URL", "http://localhost:9740")!,
  ACCOUNTS_API_URL: pick("ACCOUNTS_API_URL", "http://127.0.0.1:9741")!,
  APP_API_URL: pick("APP_API_URL", "http://127.0.0.1:4331")!,
  SESSION_SECRET: sessionSecret,
  PUBLIC_URL: `http://127.0.0.1:${PORT}`,
  EXTRA_IMG_ORIGINS: pick("EXTRA_IMG_ORIGINS", "http://127.0.0.1:9745")!,
};
// The tests read these too (e2e/support.ts).
process.env.E2E_BASE_URL = env.PUBLIC_URL;
process.env.E2E_ACCOUNTS_URL = env.ACCOUNTS_URL;
process.env.E2E_API_URL = env.APP_API_URL;
process.env.E2E_MESSAGING_URL = pick("MOCK_MESSAGING_URL", "http://127.0.0.1:9743");

// Each lane (docs/architecture.md) runs its own browser tests beside the others: its own results folder (Playwright
// empties it at the start of a run), its own sign-ins and its own `next dev` build directory.
process.env.E2E_LANE = String(PORT);

export default defineConfig({
  testDir: "./e2e",
  outputDir: `test-results/run-${PORT}`,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: env.PUBLIC_URL, headless: true, viewport: { width: 1440, height: 900 }, trace: "retain-on-failure", locale: "en-US", timezoneId: "Asia/Kolkata" },
  projects: [
    // Two Carbons sign in with an email code once per run; the specs continue as them (e2e/accounts.setup.ts).
    { name: "setup", testMatch: /accounts\.setup\.ts/, use: { browserName: "chromium" } },
    { name: "e2e", testIgnore: [/screens\.spec\.ts/, /\.setup\.ts/], dependencies: ["setup"], use: { browserName: "chromium" } },
    { name: "screens", testMatch: /screens\.spec\.ts/, dependencies: ["setup"], use: { browserName: "chromium" } },
  ],
  webServer: [
    { command: `./node_modules/.bin/next dev --port ${PORT}`, url: `http://127.0.0.1:${PORT}/robots.txt`, env: { ...env, PORT: String(PORT), NEXT_DIST_DIR: `.next-e2e-${PORT}` }, reuseExistingServer: true, timeout: 180_000 },
  ],
});
