/**
 * Sharing between two Carbons through the Share dialog, what each role lets the other Carbon do, an email invite that
 * waits, the public link opened signed out, and transfers (accept, decline, cancel).
 */
import { expect, test, type Page } from "@playwright/test";
import { call, createDeck, createFolder, deckWithSlides, signedIn, type Signed } from "./pages-support";
import { BASE } from "./support";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
let owner: Signed;
let friend: Signed;
let deck = "";
const title = `Board update ${run}`;

async function openShare(page: Page, name: string) {
  await page.goto("/decks");
  await page.getByRole("button", { name: `More actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: /^(Share|Who has access)$/ }).click();
  return page.getByRole("dialog", { name: `Share “${name}”` });
}

test.beforeAll(async ({ browser }) => {
  owner = await signedIn(browser, "carbon");
  friend = await signedIn(browser, "friend");
  deck = await createDeck(owner.context, title);
  await deckWithSlides(owner.context, deck, [{ id: "s_shr001", title: "Quarter in one slide" }]);
});

test.afterAll(async () => {
  await owner?.context.close();
  await friend?.context.close();
});

test("the friend cannot open a deck that is not shared", async () => {
  const answer = await call(friend.context, "GET", `/v1/decks/${deck}`, undefined, [403, 404]);
  expect([403, 404]).toContain(answer.status);
});

test("invite as viewer: the friend sees it in Shared with me and can only look", async () => {
  const dialog = await openShare(owner.page, title);
  await dialog.getByLabel("Invite").fill(friend.id);
  await dialog.getByRole("combobox", { name: "Role" }).click();
  await owner.page.getByRole("option", { name: "Viewer" }).click();
  await dialog.getByRole("button", { name: "Invite" }).click();
  await expect(dialog.getByRole("list").getByText(friend.id)).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: `Role for ${friend.id}` })).toContainText("Viewer");

  // A wrong id says why, next to the field.
  await dialog.getByLabel("Invite").fill("ada");
  await dialog.getByRole("button", { name: "Invite" }).click();
  await expect(dialog.getByText(/has no c: or si: in front/)).toBeVisible();
  await owner.page.keyboard.press("Escape");

  await friend.page.goto("/decks?scope=shared");
  await expect(friend.page.getByRole("heading", { level: 1, name: "Shared with me" })).toBeVisible();
  await expect(friend.page.getByRole("link", { name: title })).toBeVisible();
  await expect(friend.page.getByText(`Owner ${owner.id}`).first()).toBeVisible();

  // A viewer sees who has access but cannot invite or change anything.
  const view = await openShareShared(friend.page, title);
  await expect(view.getByText("People with access")).toBeVisible();
  await expect(view.getByLabel("Invite")).toHaveCount(0);
  await expect(view.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await friend.page.keyboard.press("Escape");

  const rename = await call(friend.context, "PATCH", `/v1/decks/${deck}`, { title: "Hijacked" }, [403]);
  expect(rename.status).toBe(403);
  const content = await call(friend.context, "GET", `/v1/decks/${deck}/content?format=json`);
  expect(content.status).toBe(200);
});

async function openShareShared(page: Page, name: string) {
  await page.goto("/decks?scope=shared");
  await page.getByRole("button", { name: `More actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: /^(Share|Who has access)$/ }).click();
  return page.getByRole("dialog", { name: `Share “${name}”` });
}

test("make the friend an editor: they can rename and invite; an email invite waits for its account", async () => {
  const dialog = await openShare(owner.page, title);
  await dialog.getByRole("combobox", { name: `Role for ${friend.id}` }).click();
  await owner.page.getByRole("option", { name: "Editor" }).click();
  await expect(dialog.getByRole("combobox", { name: `Role for ${friend.id}` })).toContainText("Editor");

  const email = `present-invite-${run}@example.test`;
  await dialog.getByLabel("Invite").fill(email);
  await dialog.getByRole("button", { name: "Invite" }).click();
  await expect(dialog.getByText(email)).toBeVisible();
  await expect(dialog.getByText(/Invite sent/)).toBeVisible();
  await owner.page.keyboard.press("Escape");

  await friend.page.goto("/decks?scope=shared");
  await friend.page.getByRole("button", { name: `More actions for ${title}` }).click();
  await friend.page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = friend.page.getByRole("dialog", { name: "Rename deck" });
  await rename.getByLabel("Title").fill(`${title} (edited)`);
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(friend.page.getByRole("link", { name: `${title} (edited)` })).toBeVisible();
  // An editor can invite, and cannot transfer, move or trash what is not theirs.
  await friend.page.getByRole("button", { name: `More actions for ${title} (edited)` }).click();
  await expect(friend.page.getByRole("menuitem", { name: "Share" })).toBeVisible();
  await expect(friend.page.getByRole("menuitem", { name: "Transfer to someone" })).toHaveCount(0);
  await expect(friend.page.getByRole("menuitem", { name: "Move to trash" })).toHaveCount(0);
  await friend.page.keyboard.press("Escape");
  await call(owner.context, "PATCH", `/v1/decks/${deck}`, { title });
});

test("the public link opens signed out, and stops working when made private", async ({ browser }) => {
  const dialog = await openShare(owner.page, title);
  const publicSwitch = dialog.getByRole("switch", { name: "Anyone with the link" });
  await expect(publicSwitch).not.toBeChecked();
  await publicSwitch.click();
  await expect(publicSwitch).toBeChecked();
  await expect(dialog.getByText(`/decks/${deck}`)).toBeVisible();
  await owner.page.keyboard.press("Escape");

  const stranger = await browser.newContext({ baseURL: BASE });
  const page = await stranger.newPage();
  const content = await page.request.get(`${BASE}/api/v1/decks/${deck}/content?format=json`);
  expect(content.status()).toBe(200);
  expect(((await content.json()) as { slides: unknown[] }).slides.length).toBe(1);
  await page.goto(`/decks/${deck}/present`);
  await expect(page).toHaveURL(new RegExp(`/decks/${deck}/present$`));
  await expect(page.getByTestId("present-stage")).toHaveAttribute("data-slide", "s_shr001");
  // The deck page itself opens signed out (the editor's view mode).
  await page.goto(`/decks/${deck}`);
  await expect(page).toHaveURL(new RegExp(`/decks/${deck}$`));

  await call(owner.context, "PUT", `/v1/decks/${deck}/public`, { mode: "off" });
  const closed = await page.request.get(`${BASE}/api/v1/decks/${deck}/content?format=json`);
  expect([401, 403, 404]).toContain(closed.status());
  await page.goto(`/decks/${deck}/present`);
  await page.waitForURL(url => !url.href.startsWith(`${BASE}/decks/`), { timeout: 30_000 });
  expect(page.url()).toMatch(/\/authorize|\/auth\/sign-in/);
  await stranger.close();
});

test("removing the friend takes their access away", async () => {
  const dialog = await openShare(owner.page, title);
  await dialog.getByRole("button", { name: `Remove ${friend.id}` }).click();
  await expect(dialog.getByRole("button", { name: `Remove ${friend.id}` })).toHaveCount(0);
  await owner.page.keyboard.press("Escape");
  await friend.page.goto("/decks?scope=shared");
  await expect(friend.page.getByRole("link", { name: title })).toHaveCount(0);
});

test("sharing a folder shares what is in it", async () => {
  const folder = await createFolder(owner.context, `Team folder ${run}`);
  await createDeck(owner.context, `Inside the folder ${run}`, folder);
  await call(owner.context, "POST", `/v1/folders/${folder}/access`, { to: friend.id, role: "commenter" });
  await friend.page.goto("/decks?scope=shared");
  await friend.page.getByRole("link", { name: `Team folder ${run}`, exact: true }).click();
  await expect(friend.page.getByRole("link", { name: `Inside the folder ${run}` })).toBeVisible();
  // The folder's deck is inside the folder, not also at the top.
  await friend.page.goto("/decks?scope=shared");
  await expect(friend.page.getByRole("link", { name: `Inside the folder ${run}` })).toHaveCount(0);
});

test("transfers: offered, declined, offered again and accepted; another cancelled", async () => {
  const gift = `Gift ${run}`;
  const giftId = await createDeck(owner.context, gift);
  await owner.page.goto("/decks");
  await owner.page.getByRole("button", { name: `More actions for ${gift}` }).click();
  await owner.page.getByRole("menuitem", { name: "Transfer to someone" }).click();
  const dialog = owner.page.getByRole("dialog", { name: `Transfer “${gift}”` });
  await dialog.getByLabel("Give it to").fill(friend.id);
  await dialog.getByRole("button", { name: "Offer transfer" }).click();
  await expect(dialog).toBeHidden();

  await friend.page.goto("/transfers");
  await friend.page.getByRole("button", { name: `Decline ${gift}` }).click();
  await expect(friend.page.getByRole("button", { name: `Decline ${gift}` })).toHaveCount(0);
  await expect(friend.page.getByRole("region", { name: "Earlier" }).getByText(gift)).toBeVisible();

  await call(owner.context, "POST", `/v1/decks/${giftId}/transfer`, { to: friend.id });
  await friend.page.goto("/transfers");
  await friend.page.getByRole("button", { name: `Accept ${gift}` }).click();
  await expect(friend.page.getByRole("button", { name: `Accept ${gift}` })).toHaveCount(0);
  await friend.page.goto("/decks");
  await expect(friend.page.getByRole("link", { name: gift })).toBeVisible();
  await owner.page.goto("/decks");
  await expect(owner.page.getByRole("link", { name: gift })).toHaveCount(0);

  const other = `Maybe ${run}`;
  const otherId = await createDeck(owner.context, other);
  await call(owner.context, "POST", `/v1/decks/${otherId}/transfer`, { to: friend.id });
  await owner.page.goto("/transfers");
  await owner.page.getByRole("button", { name: `Cancel the transfer of ${other}` }).click();
  await expect(owner.page.getByRole("button", { name: `Cancel the transfer of ${other}` })).toHaveCount(0);
  await friend.page.goto("/transfers");
  await expect(friend.page.getByRole("button", { name: `Accept ${other}` })).toHaveCount(0);
});

test("pages report no errors", async () => {
  expect(owner.errors.filter(error => !/40[134]/.test(error))).toEqual([]);
  expect(friend.errors.filter(error => !/40[134]/.test(error))).toEqual([]);
});
