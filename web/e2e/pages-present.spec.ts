/**
 * Presenting: present mode moves with the keyboard through click animations and slides, skips skipped slides, runs
 * HTML elements live; the presenter view (another window) shows notes and the next slide and moves with it; a follow
 * link followed in a second browser context (signed out, the deck is public) follows every slide change.
 */
import { expect, test } from "@playwright/test";
import { call, createDeck, deckWithSlides, signedIn, type Signed } from "./pages-support";
import { BASE } from "./support";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
let me: Signed;
let deck = "";

test.beforeAll(async ({ browser }) => {
  me = await signedIn(browser, "carbon");
  deck = await createDeck(me.context, `Talk ${run}`);
  await deckWithSlides(me.context, deck, [
    { id: "s_pre001", title: "Hello", notes: "Welcome everyone", animated: true },
    { id: "s_pre002", title: "Skipped", skipped: true },
    { id: "s_pre003", title: "Live HTML", notes: "This one runs code", html: true, transition: true },
    { id: "s_pre004", title: "Thanks" },
  ]);
});

test.afterAll(async () => {
  await me?.context.close();
});

test("keys step through animations, skip the skipped slide, and reach the end", async () => {
  const { page } = me;
  await page.goto(`/decks/${deck}/present`);
  const stage = page.getByTestId("present-stage");
  await expect(stage).toHaveAttribute("data-slide", "s_pre001");
  await expect(stage).toHaveAttribute("data-step", "0");
  // The click animation's element is hidden until the first step.
  const animated = page.locator('.sp-el[data-sp-id="e_are001"]').last();
  await expect(animated).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(stage).toHaveAttribute("data-step", "1");
  await expect(animated).toBeVisible();
  await page.keyboard.press("Space");
  await expect(stage).toHaveAttribute("data-slide", "s_pre003");
  // HTML elements run: their script changed the text inside the sandboxed frame.
  const frame = page.frameLocator('.sp-el[data-sp-id="e_hre003"] iframe').last();
  await expect(frame.locator("#out")).toHaveText("HTML ran 2", { timeout: 15_000 });
  await page.keyboard.press("ArrowLeft");
  await expect(stage).toHaveAttribute("data-slide", "s_pre001");
  await expect(stage).toHaveAttribute("data-step", "1");
  await page.keyboard.press("End");
  await expect(stage).toHaveAttribute("data-slide", "s_pre004");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("End of the presentation.")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(stage).toHaveAttribute("data-slide", "s_pre001");
  await expect(page.getByRole("toolbar", { name: "Presentation" }).getByText("1 / 3")).toBeAttached();
});

test("the presenter view shows notes and the next slide, and moves present mode with it", async () => {
  const { context, page } = me;
  await page.goto(`/decks/${deck}/present`);
  const presenter = await context.newPage();
  await presenter.goto(`/decks/${deck}/presenter`);
  await expect(presenter.getByTestId("speaker-notes")).toHaveText("Welcome everyone");
  await expect(presenter.getByText("Next: the next animation on this slide")).toBeVisible();
  await expect(presenter.getByRole("timer")).toBeVisible();

  await presenter.getByRole("button", { name: "Next", exact: true }).click();
  await presenter.getByRole("button", { name: "Next", exact: true }).click();
  await expect(presenter.getByTestId("speaker-notes")).toHaveText("This one runs code");
  await expect(page.getByTestId("present-stage")).toHaveAttribute("data-slide", "s_pre003");

  // And the other way: a key in present mode moves the presenter view.
  await page.bringToFront();
  await page.keyboard.press("ArrowRight");
  await expect(presenter.getByTestId("speaker-notes")).toHaveText("No notes for this slide.");
  await presenter.close();
});

test("a follow link: a signed-out viewer of the public deck follows every slide change", async ({ browser }) => {
  const { context, page } = me;
  await call(context, "PUT", `/v1/decks/${deck}/public`, { mode: "view" });
  await page.goto(`/decks/${deck}/present`);
  const presenter = await context.newPage();
  await presenter.goto(`/decks/${deck}/presenter`);
  await presenter.getByRole("button", { name: "Share a follow link" }).click();
  const link = await presenter.getByTestId("follow-link").textContent();
  expect(link).toMatch(new RegExp(`^${BASE}/p/[A-Za-z0-9]+$`));

  const viewer = await browser.newContext({ baseURL: BASE });
  const follower = await viewer.newPage();
  await follower.goto(link!);
  const stage = follower.getByTestId("follow-stage");
  await expect(stage).toHaveAttribute("data-slide", "s_pre001");
  await expect(follower.getByText(/^Following .* live$/)).toBeVisible({ timeout: 15_000 });

  await presenter.bringToFront();
  await presenter.keyboard.press("ArrowRight");
  await presenter.keyboard.press("ArrowRight");
  await expect(stage).toHaveAttribute("data-slide", "s_pre003", { timeout: 15_000 });
  await presenter.keyboard.press("ArrowRight");
  await expect(stage).toHaveAttribute("data-slide", "s_pre004", { timeout: 15_000 });
  // Present mode in the first window moved too.
  await expect(page.getByTestId("present-stage")).toHaveAttribute("data-slide", "s_pre004");

  await presenter.getByRole("button", { name: "End the follow link" }).click();
  await expect(follower.getByText("The presentation ended.")).toBeVisible({ timeout: 15_000 });
  await viewer.close();
  await presenter.close();
});

test("pages report no errors", async () => {
  expect(me.errors).toEqual([]);
});
