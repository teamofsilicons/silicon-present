import { expect, test } from "@playwright/test";
import { call, createDeck, createFolder, deckWithSlides, signedIn, type Signed } from "./pages-support";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
const sharedTitle = `Shared on home ${run}`;
const ownTitle = `My home deck ${run}`;
const privateTitle = `Private elsewhere ${run}`;
const folderTitle = `Shared folder on home ${run}`;
const insideTitle = `Inside shared folder ${run}`;
let owner: Signed;
let recipient: Signed;
let sharedDeck = "";

test.beforeAll(async ({ browser }) => {
  owner = await signedIn(browser, "carbon");
  recipient = await signedIn(browser, "friend");
  sharedDeck = await createDeck(owner.context, sharedTitle);
  await deckWithSlides(owner.context, sharedDeck, [{ id: "s_hom001", title: "Shared with you" }]);
  await createDeck(owner.context, privateTitle);
  await call(owner.context, "POST", `/v1/decks/${sharedDeck}/access`, { to: recipient.id, role: "viewer" });
});

test.afterAll(async () => {
  await owner?.context.close();
  await recipient?.context.close();
});

test("home shows shared decks immediately, alongside owned decks, with working filters", async () => {
  const { page } = recipient;
  await page.goto("/decks");
  await expect(page.getByRole("button", { name: "All decks", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: sharedTitle, exact: true })).toBeVisible();
  await expect(page.getByText("No decks yet", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: privateTitle, exact: true })).toHaveCount(0);

  const ownDeck = await createDeck(recipient.context, ownTitle);
  await deckWithSlides(recipient.context, ownDeck, [{ id: "s_hom002", title: "Made by you" }]);
  await page.reload();
  await expect(page.getByRole("link", { name: ownTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: sharedTitle, exact: true })).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("home-shared-desktop.png"), fullPage: true });

  // The initial server response must contain both lists, before any browser refetch.
  const response = await recipient.context.request.get(page.url());
  expect(response.ok()).toBe(true);
  const firstPaint = await response.text();
  expect(firstPaint).toContain(sharedTitle);
  expect(firstPaint).toContain(ownTitle);

  const filters = page.getByRole("group", { name: "Which decks" });
  await filters.getByRole("button", { name: "My decks", exact: true }).click();
  await expect(page).toHaveURL(/scope=mine/);
  await expect(page.getByRole("link", { name: ownTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: sharedTitle, exact: true })).toHaveCount(0);
  await filters.getByRole("button", { name: "Shared with me", exact: true }).click();
  await expect(page.getByRole("link", { name: sharedTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: ownTitle, exact: true })).toHaveCount(0);
  await filters.getByRole("button", { name: "All decks", exact: true }).click();
  await expect(page).toHaveURL(/\/decks$/);
  await expect(page.getByRole("link", { name: ownTitle, exact: true })).toBeVisible();

  await page.getByRole("button", { name: `More actions for ${sharedTitle}` }).click();
  await expect(page.getByRole("menuitem", { name: "Who has access", exact: true })).toBeVisible();
  for (const name of ["Rename", "Move", "Move to trash"]) await expect(page.getByRole("menuitem", { name, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("link", { name: sharedTitle, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("home-shared-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("shared folders open from home with their existing permissions and a path back", async () => {
  const folder = await createFolder(owner.context, folderTitle);
  await createDeck(owner.context, insideTitle, folder);
  await call(owner.context, "POST", `/v1/folders/${folder}/access`, { to: recipient.id, role: "viewer" });
  const { page } = recipient;
  await page.goto("/decks");
  await page.getByRole("link", { name: folderTitle, exact: true }).click();
  await expect(page.getByRole("link", { name: insideTitle, exact: true })).toBeVisible();
  for (const name of ["New deck", "New folder", "Open a file"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Folder path" }).getByRole("link", { name: "All decks", exact: true }).click();
  await expect(page).toHaveURL(/\/decks$/);
  await expect(page.getByRole("link", { name: sharedTitle, exact: true })).toBeVisible();
});

test("revoked shares leave the home listing on refresh", async () => {
  const { body } = await call<{ members: Array<{ member: string; account?: { id: string } }> }>(owner.context, "GET", `/v1/decks/${sharedDeck}/access`);
  const member = body.members.find(entry => entry.account?.id === recipient.id)!;
  expect(member).toBeTruthy();
  await call(owner.context, "DELETE", `/v1/decks/${sharedDeck}/access/${encodeURIComponent(member.member)}`);
  await recipient.page.reload();
  await expect(recipient.page.getByRole("link", { name: sharedTitle, exact: true })).toHaveCount(0);
  await expect(recipient.page.getByRole("link", { name: ownTitle, exact: true })).toBeVisible();
  expect(recipient.errors).toEqual([]);
});
