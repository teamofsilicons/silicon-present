/**
 * History: two Carbons change one deck in turns; the history lists their versions newest first with events between;
 * a version opens read-only; two versions compare slide by slide; a version gets a name; one Carbon's changes since a
 * version are undone; a whole version is restored; a slide is brought back; a new deck is made from a version.
 */
import { expect, test } from "@playwright/test";
import { call, createDeck, deckWithSlides, edit, signedIn, textElement, type Signed } from "./pages-support";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
let owner: Signed;
let friend: Signed;
let deck = "";
const title = `History check ${run}`;
type Content = { slides: Array<{ id: string; elements: Array<{ id: string; text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> } }> }> };
const texts = (content: Content) => content.slides.flatMap(slide => slide.elements.map(element => element.text?.paragraphs.map(p => p.runs.map(r => r.text).join("")).join("\n") ?? ""));
let firstVersion = 0;

test.beforeAll(async ({ browser }) => {
  owner = await signedIn(browser, "carbon");
  friend = await signedIn(browser, "friend");
  deck = await createDeck(owner.context, title);
  await call(owner.context, "POST", `/v1/decks/${deck}/access`, { to: friend.id, role: "editor" });
  await deckWithSlides(owner.context, deck, [{ id: "s_his001", title: "Owner's first slide" }]);
  firstVersion = (await call<{ version: number }>(owner.context, "GET", `/v1/decks/${deck}`)).body.version;
  // The friend adds a slide and changes the owner's text; then the owner renames the deck and adds another slide.
  await edit(friend.context, deck, [
    { op: "add_slide", after: "s_his001", slide: { id: "s_his002", layout: "blank", elements: [textElement("e_fr0001", "Friend's slide")] } },
    { op: "replace_text", slide: "s_his001", element: "e_tis001", find: "Owner's first slide", replace: "Friend changed this" },
  ], "Friend's changes");
  await call(owner.context, "PATCH", `/v1/decks/${deck}`, { title: `${title} renamed` });
  await edit(owner.context, deck, [{ op: "add_slide", after: "s_his002", slide: { id: "s_his003", layout: "blank", elements: [textElement("e_ow0003", "Owner's last slide")] } }], "Owner's last slide");
});

/** The version the owner's first slides made ("… built the test slides"). */
const builtVersion = (page: Signed["page"]) => page.getByTestId("version").filter({ hasText: "built the test slides" });

test.afterAll(async () => {
  await owner?.context.close();
  await friend?.context.close();
});

test("versions newest first, by who made them, with the events between", async () => {
  const { page } = owner;
  await page.goto(`/decks/${deck}/history`);
  await expect(page.getByRole("heading", { level: 1, name: "History" })).toBeVisible();
  const versions = page.getByTestId("version");
  await expect(versions.first()).toBeVisible();
  expect(await versions.count()).toBeGreaterThanOrEqual(3);
  await expect(versions.first()).toContainText(owner.id);
  await expect(versions.first()).toContainText("Current");
  await expect(page.getByTestId("version").filter({ hasText: friend.id }).first()).toBeVisible();
  await expect(page.getByTestId("history-event").filter({ hasText: /renamed|title/i }).first()).toBeVisible();
});

test("open an older version read-only and compare two versions slide by slide", async () => {
  const { page } = owner;
  await page.goto(`/decks/${deck}/history`);
  await builtVersion(page).getByRole("button", { name: /^Open version/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: `Version ${firstVersion}` })).toBeVisible();
  await expect(page.getByRole("list", { name: "Slides in this version" }).getByRole("listitem")).toHaveCount(1);

  await page.getByRole("button", { name: "Compare" }).click();
  const comparison = page.getByTestId("comparison");
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText(/Added|Changed/).first()).toBeVisible();
});

test("name a version", async () => {
  const { page } = owner;
  await page.goto(`/decks/${deck}/history`);
  await builtVersion(page).getByRole("button", { name: /^Actions for version/ }).click();
  await page.getByRole("menuitem", { name: "Name this version" }).click();
  const dialog = page.getByRole("dialog", { name: /^Name version/ });
  await dialog.getByLabel("Name").fill(`Sent to the client ${run}`);
  await dialog.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByTestId("version").filter({ hasText: `Sent to the client ${run}` })).toBeVisible();
});

test("undo one Carbon's changes since a version, from the history", async () => {
  const { page } = owner;
  await page.goto(`/decks/${deck}/history`);
  await builtVersion(page).getByRole("button", { name: /^Actions for version/ }).click();
  await page.getByRole("menuitem", { name: "Undo one account's changes since this version" }).click();
  const dialog = page.getByRole("dialog", { name: "Undo one account's changes" });
  await dialog.getByRole("combobox", { name: "Whose changes" }).click();
  await page.getByRole("option", { name: new RegExp(friend.id.replace(":", "\\:")) }).click();
  await dialog.getByRole("button", { name: `Undo ${friend.id}'s changes` }).click();
  await expect(dialog).toBeHidden();
  // The undo is a new version at the top, and the friend's work is gone from the deck.
  await expect(page.getByTestId("version").first()).toContainText(/undid/i);
  const words = texts((await call<Content>(owner.context, "GET", `/v1/decks/${deck}/content?format=json`)).body).join(" | ");
  expect(words).not.toContain("Friend's slide");
  expect(words).not.toContain("Friend changed this");
});

test("after undoing the friend, the owner's own text and later slide are still there", async () => {
  /*
   * Known service bug (a114058): undo-account replays the owner's later update without the friend's earlier one, and
   * that update stays pending in Yjs (it was positioned after the friend's slide), so the owner's slide s_his003 is
   * dropped; and the text the friend changed ends empty instead of back at "Owner's first slide". Expected per
   * UNDERSTANDING.md "Versions": only the friend's changes go. Remove test.fail() once the service is fixed.
   */
  test.fail();
  const words = texts((await call<Content>(owner.context, "GET", `/v1/decks/${deck}/content?format=json`)).body).join(" | ");
  expect(words).toContain("Owner's first slide");
  expect(words).toContain("Owner's last slide");
});

test("restore a whole version, then bring back one slide", async () => {
  const { page } = owner;
  await page.goto(`/decks/${deck}/history`);
  await builtVersion(page).getByRole("button", { name: /^Actions for version/ }).click();
  await page.getByRole("menuitem", { name: "Restore this version" }).click();
  await page.getByRole("dialog", { name: /^Restore version/ }).getByRole("button", { name: "Restore this version" }).click();
  await expect(page.getByRole("dialog", { name: /^Restore version/ })).toBeHidden();
  let content = (await call<Content>(owner.context, "GET", `/v1/decks/${deck}/content?format=json`)).body;
  expect(content.slides.map(slide => slide.id)).toEqual(["s_his001"]);

  // The version where the owner added their last slide still has it: bring back just that slide.
  await page.reload();
  const before = page.getByTestId("version").filter({ hasText: "owner's last slide" });
  await before.getByRole("button", { name: /^Open version/ }).click();
  const strip = page.getByRole("list", { name: "Slides in this version" });
  await strip.getByRole("button", { name: /^Slide 3/ }).click();
  await page.getByRole("button", { name: "Bring back this slide" }).click();
  await expect.poll(async () => (await call<Content>(owner.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides.map(slide => slide.id)).toContain("s_his003");
  content = (await call<Content>(owner.context, "GET", `/v1/decks/${deck}/content?format=json`)).body;
  expect(texts(content).join(" ")).toContain("Owner's last slide");
});

test("make a new deck from an older version", async () => {
  const { page } = owner;
  await page.goto(`/decks/${deck}/history`);
  await builtVersion(page).getByRole("button", { name: /^Actions for version/ }).click();
  await page.getByRole("menuitem", { name: "Make a new deck from this version" }).click();
  await page.waitForURL(url => /\/decks\/[A-Za-z0-9]+$/.test(url.pathname) && !url.pathname.endsWith(deck));
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const content = (await call<Content>(owner.context, "GET", `/v1/decks/${id}/content?format=json`)).body;
  expect(content.slides.map(slide => slide.id)).toEqual(["s_his001"]);
});

test("pages report no errors", async () => {
  expect(owner.errors).toEqual([]);
});
