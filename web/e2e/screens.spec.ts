/**
 * Screenshots for review (`pnpm screens`): every demo page and the public pages, light and dark, desktop (1440 x 900)
 * and phone (390 x 844), into screens/. A fresh Carbon signs in through the hosted pages; a second one exists to share
 * with, so the sharing views show a real account chip. Motion is reduced so nothing is caught mid-animation.
 */
import { mkdirSync } from "node:fs";
import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { accountsSession, BASE, runAccounts, sameOrigin, signIn } from "./support";

const OUT = "screens";
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;
const THEMES = ["light", "dark"] as const;
type Viewport = keyof typeof VIEWPORTS;
type Theme = (typeof THEMES)[number];

test.describe.configure({ mode: "serial" });

let signedIn: BrowserContext;
let itemId = "";
let friendId = "";

async function contextFor(browser: Browser, viewport: Viewport, theme: Theme, storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>) {
  return browser.newContext({ baseURL: BASE, viewport: VIEWPORTS[viewport], colorScheme: theme, reducedMotion: "reduce", deviceScaleFactor: viewport === "mobile" ? 2 : 1, storageState, hasTouch: viewport === "mobile", isMobile: viewport === "mobile" });
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function shot(page: Page, name: string, fullPage = true) {
  await settle(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const accounts = runAccounts();
  friendId = accounts.friend.id;
  signedIn = await accountsSession(browser, "carbon", { viewport: VIEWPORTS.desktop });
  const page = await signedIn.newPage();
  await signIn(page, accounts.carbon.email, "/items");
  // A richer item: shared with the friend (a real account chip with a name and photo) and edited once.
  const created = await page.request.post("/api/v1/items", { headers: sameOrigin({ "Content-Type": "application/json" }), data: { title: "Plan the Silicon onboarding week", description: "Install, sign in with a short-lived token, and find everything shared with you on the first day.", status: "active" } });
  itemId = (await created.json()).id;
  await page.request.put(`/api/v1/items/${itemId}/shares`, { headers: sameOrigin({ "Content-Type": "application/json" }), data: { ids: [friendId] } });
  await page.request.patch(`/api/v1/items/${itemId}`, { headers: sameOrigin({ "Content-Type": "application/json" }), data: { description: "Install, sign in with a short-lived token, and find everything shared with you on day one." } });
  await page.request.patch("/api/v1/settings", { headers: sameOrigin({ "Content-Type": "application/json" }), data: { default_shares: [friendId] } });
  await page.close();
});

test.afterAll(async () => {
  await signedIn?.close();
});

for (const viewport of Object.keys(VIEWPORTS) as Viewport[]) {
  for (const theme of THEMES) {
    test(`public pages, ${theme}, ${viewport}`, async ({ browser }) => {
      const context = await contextFor(browser, viewport, theme);
      const page = await context.newPage();
      await page.goto("/");
      await shot(page, `landing-${theme}-${viewport}`);
      await page.goto("/sign-in");
      await shot(page, `sign-in-${theme}-${viewport}`);
      if (theme === "light" || viewport === "desktop") {
        await page.goto("/sign-in?error=access_denied");
        await shot(page, `sign-in-cancelled-${theme}-${viewport}`);
        await page.goto("/no/such/page");
        await shot(page, `not-found-${theme}-${viewport}`);
      }
      await context.close();
    });

    test(`workspace pages, ${theme}, ${viewport}`, async ({ browser }) => {
      const context = await contextFor(browser, viewport, theme, await signedIn.storageState());
      const page = await context.newPage();
      await page.goto("/items");
      await shot(page, `items-${theme}-${viewport}`);
      await page.goto(`/items/${itemId}`);
      await shot(page, `item-${theme}-${viewport}`);
      await page.goto("/settings");
      await shot(page, `settings-${theme}-${viewport}`);

      // The states in between: the sharing tab, a dialog, an empty state, the palette, the menus.
      await page.goto(`/items/${itemId}`);
      await page.getByRole("tab", { name: "Sharing" }).click();
      await shot(page, `item-sharing-${theme}-${viewport}`);
      await page.getByRole("tab", { name: "History" }).click();
      await shot(page, `item-history-${theme}-${viewport}`);
      await page.getByRole("button", { name: "Edit" }).click();
      await page.getByRole("dialog", { name: "Edit item" }).waitFor();
      await shot(page, `item-edit-dialog-${theme}-${viewport}`, false);
      await page.keyboard.press("Escape");
      await page.goto("/items");
      await page.getByRole("searchbox", { name: "Search items" }).fill("no such thing");
      await shot(page, `items-empty-${theme}-${viewport}`);
      if (viewport === "mobile") {
        await page.getByRole("button", { name: "Open the menu" }).click();
        await page.getByRole("dialog", { name: "Web Kit" }).waitFor();
        await shot(page, `menu-sheet-${theme}-${viewport}`, false);
        await page.keyboard.press("Escape");
      } else {
        await page.keyboard.press("Meta+K");
        await page.getByRole("dialog", { name: "Search and jump" }).waitFor();
        await shot(page, `command-palette-${theme}-${viewport}`, false);
        await page.keyboard.press("Escape");
      }
      await page.getByRole("button", { name: /^Account menu, / }).click();
      await page.getByRole("menu").waitFor();
      await shot(page, `account-menu-${theme}-${viewport}`, false);
      await context.close();
    });
  }
}
