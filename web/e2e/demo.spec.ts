/**
 * The demo pages on the real Accounts stack: the list, the detail page, settings, sharing with a second Carbon who
 * signed in elsewhere, and the API proxy end to end against demo/stub-api.mjs. Delete this file with demo/ when an app
 * adopts the kit, and write its own the same way.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { accountsSession, putSession, runAccounts, sameOrigin, sessionOf, signIn, storedSession, watchErrors } from "./support";

test.describe.configure({ mode: "serial" });

let friendContext: BrowserContext;
let friendId = "";
let context: BrowserContext;
let page: Page;
let me = "";
let errors: string[] = [];

test.beforeAll(async ({ browser }) => {
  const accounts = runAccounts();
  friendContext = await accountsSession(browser, "friend");
  const friend = await friendContext.newPage();
  await signIn(friend, accounts.friend.email, "/items");
  friendId = (await sessionOf(friendContext)).account!.id;
  await friend.close();
  context = await accountsSession(browser, "carbon", { viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  errors = watchErrors(page);
  await signIn(page, accounts.carbon.email, "/items");
  me = (await sessionOf(context)).account!.id;
});

test.afterAll(async () => {
  await friendContext?.close();
  await context?.close();
});

test("the list: sortable table, search, filters and empty states", async () => {
  const table = page.getByRole("table", { name: "Items" });
  await expect(table.getByRole("row")).toHaveCount(7);
  const search = page.getByRole("searchbox", { name: "Search items" });
  await search.fill("launch");
  await expect(table.getByRole("row")).toHaveCount(2);
  await search.fill("nothing-matches-this");
  await expect(page.getByRole("heading", { name: "Nothing matches" })).toBeVisible();
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(table.getByRole("row")).toHaveCount(7);

  await page.getByRole("button", { name: "Add filter" }).click();
  await page.getByRole("menuitem", { name: /Status/ }).click();
  await page.getByRole("menuitemradio", { name: /Done/ }).or(page.getByRole("menuitem", { name: /Done/ })).first().click();
  await expect(table.getByRole("row")).toHaveCount(3);
  await page.getByRole("button", { name: "Remove Status: Done" }).click();
  await expect(table.getByRole("row")).toHaveCount(7);

  await table.getByRole("button", { name: /^Sort by Title/ }).click();
  await expect(table.getByRole("row").nth(1)).toContainText("Move the data to account uuids");
});

test("create, open, edit and share an item", async () => {
  await page.getByRole("button", { name: "New item" }).click();
  const dialog = page.getByRole("dialog", { name: "New item" });
  await dialog.getByRole("button", { name: "Create item" }).click();
  const title = dialog.getByRole("textbox", { name: "Title" });
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toHaveAccessibleDescription(/Give the item a title\./);
  await title.fill("Kit browser test");
  await dialog.getByRole("textbox", { name: "Description" }).fill("Made by the e2e run.");
  await dialog.getByRole("button", { name: "Create item" }).click();
  await expect(dialog).toBeHidden();
  const link = page.getByRole("table", { name: "Items" }).getByRole("link", { name: "Kit browser test" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/items\/itm_[A-Za-z0-9_-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kit browser test");

  await page.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit item" });
  await edit.getByRole("textbox", { name: "Title" }).fill("Kit browser test, edited");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kit browser test, edited");

  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByRole("list", { name: "History, newest first" })).toContainText("edited title");

  await page.getByRole("tab", { name: "Sharing" }).click();
  const field = page.getByRole("textbox", { name: "Share with" });
  await field.fill("ada@example.com");
  await field.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "looks like an email address" })).toBeVisible();
  await field.fill(me);
  await field.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "is you" })).toBeVisible();
  const missing = `c:nobody-${Date.now().toString(36)}`;
  await field.fill(missing);
  await field.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: missing })).toBeVisible();
  await page.getByRole("button", { name: `Remove ${missing}` }).click();
  await field.fill(friendId);
  await field.press("Enter");
  const chips = page.getByRole("list", { name: /^Share with: 1 account$/ });
  await expect(chips).toContainText(friendId);
  await page.getByRole("button", { name: "Save sharing" }).click();
  await expect(page.getByText("Sharing saved")).toBeVisible();

  // The friend sees it, shared by this Carbon, and cannot delete it.
  const friend = await friendContext.newPage();
  await friend.goto("/items");
  await expect(friend.getByRole("link", { name: "Kit browser test, edited" })).toBeVisible();
  await friend.getByRole("link", { name: "Kit browser test, edited" }).click();
  await expect(friend.getByText(me).first()).toBeVisible();
  await expect(friend.getByRole("button", { name: /Hold to delete/ })).toHaveCount(0);
  await friend.waitForLoadState("networkidle");
  await friend.close();
});

test("delete with a hold, from the keyboard", async () => {
  await page.getByRole("tab", { name: "Overview" }).click();
  const hold = page.getByRole("button", { name: "Hold to delete" });
  await hold.focus();
  await page.keyboard.down("Space");
  await page.waitForTimeout(1700);
  await page.keyboard.up("Space");
  await expect(page).toHaveURL(/\/items$/);
  await expect(page.getByText("Item deleted")).toBeVisible();
  await expect(page.getByRole("table", { name: "Items" }).getByRole("link", { name: "Kit browser test, edited" })).toHaveCount(0);
});

test("settings: switches save at once and default sharing resolves accounts", async () => {
  await page.getByRole("link", { name: "Settings" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const weekly = page.getByRole("switch", { name: "Weekly summary" });
  await expect(weekly).not.toBeChecked();
  await weekly.click();
  await expect(weekly).toBeChecked();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Weekly summary" })).toBeChecked();

  const field = page.getByRole("textbox", { name: "Share new items with" });
  await field.fill(friendId);
  await field.press("Enter");
  await page.getByRole("button", { name: "Save default sharing" }).click();
  await expect(page.getByText("Default sharing saved")).toBeVisible();
  await expect(page.getByText(me).first()).toBeVisible();
});

test("the API proxy forwards what describes the request and nothing that authenticates the browser", async () => {
  const body = "x".repeat(70_000);
  const response = await page.request.post("/api/v1/echo?from=kit&n=2", {
    headers: sameOrigin({ "Content-Type": "text/plain", "Idempotency-Key": "kit-e2e-1", "X-Custom": "never", Authorization: "Bearer forged", "X-Request-Id": "req-kit" }),
    data: body,
  });
  expect(response.status()).toBe(200);
  const echo = await response.json();
  expect(echo.method).toBe("POST");
  expect(echo.query).toEqual({ from: "kit", n: "2" });
  expect(echo.authorization).toBe("Bearer (verified)");
  expect(echo.account.id).toBe(me);
  expect(echo.body_bytes).toBe(body.length);
  expect(echo.headers["idempotency-key"]).toBe("kit-e2e-1");
  expect(echo.headers["x-request-id"]).toBe("req-kit");
  expect(echo.headers.cookie).toBeUndefined();
  expect(echo.headers.origin).toBeUndefined();
  expect(echo.headers["x-custom"]).toBeUndefined();
  const headers = response.headers();
  expect(headers["cache-control"]).toBe("private, no-store");
  expect(headers.etag).toBe('"echo-1"');
  expect(headers["set-cookie"]).toBeUndefined();
  expect(headers["x-total-count"]).toBeUndefined();

  const missing = await page.request.get("/api/v1/items/itm_nope");
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error).toMatchObject({ code: "not_found" });
  // An encoded slash could climb out of the service's path once decoded: refused, never forwarded.
  const smuggled = await page.request.get("/api/v1/items%2F..%2Fsettings");
  expect(smuggled.status()).toBe(400);
  expect((await smuggled.json()).error.code).toBe("invalid_path");
});

test("five API calls at once with an expiring token refresh once, and the sign-in survives", async () => {
  const { session } = await storedSession(context);
  await putSession(context, session, 10_000);
  const answers = await Promise.all([1, 2, 3, 4, 5].map(() => page.request.get("/api/v1/items")));
  expect(answers.map(answer => answer.status())).toEqual([200, 200, 200, 200, 200]);
  const { session: after } = await storedSession(context);
  expect(after.rt).not.toBe(session.rt);
  // Two refreshes with one token would have ended the whole sign-in at Silicon Accounts; this one still works.
  await putSession(context, after, 10_000);
  expect((await page.request.get("/api/v1/items")).status()).toBe(200);
});

test("a page the service says is not there renders the workspace's not-found page", async () => {
  // The page streams behind its loading skeleton, so the status is already 200 when notFound() happens; the page says
  // so instead, and tells crawlers not to keep it.
  await page.goto("/items/itm_does_not_exist");
  await expect(page.getByRole("heading", { name: "This is not here" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Web Kit", exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
});

test("no page reported an error or a hydration mismatch along the way", async () => {
  expect(errors).toEqual([]);
});
