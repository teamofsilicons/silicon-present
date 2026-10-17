/**
 * `pnpm screens`: full-page PNGs of every page this part of the web owns, at 1440 and 390 wide (light only), into
 * screens/, for looking at by eye: wrapped separators, cut-off text, truncation mid-word, doubled empty states, and
 * sideways scroll (measured here too: no page may scroll sideways).
 */
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { call, createDeck, createFolder, deckWithSlides, signedIn, type Signed } from "./pages-support";
import { BASE } from "./support";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
let owner: Signed;
let friend: Signed;
let deck = "";
let folder = "";
let presentation = "";
const OUT = "screens";

async function shoot(page: Page, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(500);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways, `${name} scrolls sideways by ${sideways}px`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  owner = await signedIn(browser, "carbon", { reducedMotion: "reduce" });
  friend = await signedIn(browser, "friend", { reducedMotion: "reduce" });
  folder = await createFolder(owner.context, `Quarterly reviews ${run}`);
  await createDeck(owner.context, `Q3 numbers with a long title that has to fit on a phone ${run}`, folder);
  deck = await createDeck(owner.context, `Q4 review ${run}`);
  await deckWithSlides(owner.context, deck, [
    { id: "s_scr001", title: "Q4 review", notes: "Open with the headline number.", animated: true },
    { id: "s_scr002", title: "Revenue grew 40%", html: true, transition: true },
    { id: "s_scr003", title: "Next quarter" },
  ]);
  await call(owner.context, "POST", `/v1/decks/${deck}/access`, { to: friend.id, role: "editor" });
  await call(friend.context, "POST", `/v1/decks/${deck}/edits`, { ops: [{ op: "update_slide", slide: "s_scr003", set: { notes: "Friend's note" } }] });
  await call(owner.context, "POST", `/v1/decks/${deck}/access`, { to: `screens-${run}@example.test`, role: "commenter" });
  const shared = await createDeck(friend.context, `Shared by a friend ${run}`);
  await call(friend.context, "POST", `/v1/decks/${shared}/access`, { to: owner.id, role: "commenter" });
  const old = await createDeck(owner.context, `Old draft ${run}`);
  await call(owner.context, "DELETE", `/v1/decks/${old}`);
  const gift = await createDeck(friend.context, `A deck offered to you ${run}`);
  await call(friend.context, "POST", `/v1/decks/${gift}/transfer`, { to: owner.id });
  const started = await call<{ id: string }>(owner.context, "POST", `/v1/decks/${deck}/presentations`, {});
  presentation = started.body.id;
  await call(owner.context, "PUT", `/v1/decks/${deck}/public`, { mode: "view" });
});

test.afterAll(async () => {
  await owner?.context.close();
  await friend?.context.close();
});

for (const [width, height, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]] as const) {
  test(`every page at ${width}`, async () => {
    test.setTimeout(300_000);
    const { page } = owner;
    await page.setViewportSize({ width, height });
    const pages: Array<[string, string]> = [
      ["decks", "/decks"],
      ["decks-shared", "/decks?scope=shared"],
      ["decks-folder", `/decks?folder=${folder}`],
      ["trash", "/trash"],
      ["transfers", "/transfers"],
      ["history", `/decks/${deck}/history`],
      ["presenter", `/decks/${deck}/presenter`],
      ["present", `/decks/${deck}/present`],
      ["follow", `/p/${presentation}`],
    ];
    for (const [name, path] of pages) {
      await page.goto(path);
      await shoot(page, `${name}-${tag}`);
    }

    await page.goto("/decks");
    await page.getByRole("button", { name: `More actions for Q4 review ${run}` }).click();
    await shoot(page, `decks-menu-${tag}`);
    await page.getByRole("menuitem", { name: "Share" }).click();
    await page.getByRole("dialog").getByText("People with access").waitFor();
    await shoot(page, `share-${tag}`);
    await page.keyboard.press("Escape");

    await page.goto(`/decks/${deck}/history`);
    await page.getByRole("button", { name: "Compare" }).click();
    await page.getByTestId("comparison").waitFor().catch(() => undefined);
    await shoot(page, `history-compare-${tag}`);
    await page.getByRole("button", { name: "Download" }).first().click();
    await shoot(page, `export-menu-${tag}`);
    await page.keyboard.press("Escape");

    const anonymous = await page.context().browser()!.newContext({ baseURL: BASE, viewport: { width, height }, reducedMotion: "reduce" });
    const visitor = await anonymous.newPage();
    for (const [name, path] of [["landing", "/"], ["public-present", `/decks/${deck}/present`], ["public-follow", `/p/${presentation}`]] as const) {
      await visitor.goto(path);
      await shoot(visitor, `${name}-${tag}`);
    }
    await anonymous.close();
  });
}
