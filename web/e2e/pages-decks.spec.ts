/**
 * Decks and folders through the pages, against the real service: a new folder and a deck inside it, breadcrumbs,
 * rename, move, search, trash, restore, and deleting for good (which asks to type the name).
 */
import { expect, test } from "@playwright/test";
import { call, createDeck, deckWithSlides, signedIn, type Signed } from "./pages-support";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
let me: Signed;

test.beforeAll(async ({ browser }) => {
  me = await signedIn(browser, "carbon");
});

test.afterAll(async () => {
  await me?.context.close();
});

test("a new folder, a deck inside it, and breadcrumbs back up", async () => {
  const { page } = me;
  await page.goto("/decks");
  await expect(page.getByRole("heading", { level: 1, name: "Decks" })).toBeVisible();

  await page.getByRole("button", { name: "New folder" }).click();
  const folderDialog = page.getByRole("dialog", { name: "New folder" });
  await folderDialog.getByLabel("Name").fill(`Plans ${run}`);
  await folderDialog.getByRole("button", { name: "Create folder" }).click();
  await expect(folderDialog).toBeHidden();
  const folderLink = page.getByRole("link", { name: `Plans ${run}`, exact: true });
  await expect(folderLink).toBeVisible();
  await folderLink.click();
  await expect(page).toHaveURL(/\/decks\?folder=/);
  await expect(page.getByRole("heading", { level: 1, name: `Plans ${run}` })).toBeVisible();
  await expect(page.getByText("This folder is empty")).toBeVisible();

  // A deck made here goes into this folder; New deck opens it in the editor.
  await page.getByRole("button", { name: "New deck" }).first().click();
  const deckDialog = page.getByRole("dialog", { name: "New deck" });
  await deckDialog.getByLabel("Title").fill(`Roadmap ${run}`);
  await deckDialog.getByRole("button", { name: "Create deck" }).click();
  await expect(page).toHaveURL(/\/decks\/[A-Za-z0-9]+(\?.*)?$/);

  await page.goBack();
  await expect(page.getByRole("link", { name: `Roadmap ${run}`, exact: true })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Folder path" });
  await expect(crumbs.getByText(`Plans ${run}`)).toHaveAttribute("aria-current", "page");
  await crumbs.getByRole("link", { name: "All decks" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Decks" })).toBeVisible();
  // On home the deck is inside its folder, not beside it.
  await expect(page.getByRole("link", { name: `Plans ${run}`, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `Roadmap ${run}`, exact: true })).toHaveCount(0);
});

test("rename and move from a row's menu", async () => {
  const { page } = me;
  await page.goto("/decks");
  await page.getByRole("link", { name: `Plans ${run}`, exact: true }).click();
  await page.getByRole("button", { name: `More actions for Roadmap ${run}` }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename deck" });
  await rename.getByLabel("Title").fill(`Roadmap 2027 ${run}`);
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("link", { name: `Roadmap 2027 ${run}`, exact: true })).toBeVisible();

  await page.getByRole("button", { name: `More actions for Roadmap 2027 ${run}` }).click();
  await page.getByRole("menuitem", { name: "Move", exact: true }).click();
  const move = page.getByRole("dialog", { name: `Move “Roadmap 2027 ${run}”` });
  await move.getByRole("button", { name: "Move to My decks" }).click();
  await expect(move).toBeHidden();
  await expect(page.getByText("This folder is empty")).toBeVisible();
  await page.goto("/decks");
  await expect(page.getByRole("link", { name: `Roadmap 2027 ${run}`, exact: true })).toBeVisible();

  // Rename the folder too.
  await page.getByRole("button", { name: `More actions for Plans ${run}` }).click();
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const renameFolder = page.getByRole("dialog", { name: "Rename folder" });
  await renameFolder.getByLabel("Name").fill(`Plans and ideas ${run}`);
  await renameFolder.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("link", { name: `Plans and ideas ${run}`, exact: true })).toBeVisible();
});

test("search finds a deck by the words on its slides", async () => {
  const { page, context } = me;
  const id = await createDeck(context, `Search target ${run}`);
  await deckWithSlides(context, id, [{ id: "s_srch01", title: `Pelican migration ${run}` }]);
  await page.goto("/decks");
  await page.getByRole("searchbox", { name: "Search decks" }).fill(`Pelican migration ${run}`);
  await expect(page.getByRole("region", { name: "Search results" }).getByRole("link", { name: `Search target ${run}`, exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search decks" }).fill(`nothing-like-this-${run}`);
  await expect(page.getByText(`No deck matches “nothing-like-this-${run}”`)).toBeVisible();
  await page.getByRole("button", { name: "Clear the search" }).click();
  await expect(page.getByRole("link", { name: `Roadmap 2027 ${run}`, exact: true })).toBeVisible();
});

test("trash, restore, and delete for good after typing the name", async () => {
  const { page, context } = me;
  const title = `Old pitch ${run}`;
  const id = await createDeck(context, title);
  await page.goto("/decks");
  await page.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByRole("link", { name: title, exact: true })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Present" }).getByRole("link", { name: "Trash" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trash" })).toBeVisible();
  await page.getByRole("button", { name: `Restore ${title}` }).click();
  await expect(page.getByRole("button", { name: `Restore ${title}` })).toHaveCount(0);
  await page.goto("/decks");
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();

  await call(context, "DELETE", `/v1/decks/${id}`);
  await page.goto("/trash");
  await page.getByRole("button", { name: `Delete forever: ${title}` }).click();
  const confirm = page.getByRole("dialog", { name: `Delete “${title}” forever?` });
  const button = confirm.getByRole("button", { name: "Delete forever" });
  await expect(button).toBeDisabled();
  await confirm.getByLabel("Type the deck's title").fill("Old pitch");
  await expect(button).toBeDisabled();
  await confirm.getByLabel("Type the deck's title").fill(title);
  await button.click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole("button", { name: `Restore ${title}` })).toHaveCount(0);
  const gone = await call(context, "GET", `/v1/decks/${id}`, undefined, [404, 410]);
  expect([404, 410]).toContain(gone.status);
});

test("pages report no errors", async () => {
  expect(me.errors).toEqual([]);
});
