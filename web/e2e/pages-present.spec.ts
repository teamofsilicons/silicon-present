/**
 * Presenting: present mode moves with the keyboard through click animations and slides, skips skipped slides, runs
 * HTML elements live; the presenter view (another window) shows notes and the next slide and moves with it; a follow
 * link followed in a second browser context (signed out, the deck is public) follows every slide change.
 */
import { expect, test, type Page } from "@playwright/test";
import { call, createDeck, deckWithSlides, edit, signedIn, type Signed } from "./pages-support";
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
  // An element that reloads its own frame once: it must run again after the reload, not go blank.
  await edit(me.context, deck, [{
    op: "add_element",
    slide: "s_pre004",
    element: { id: "e_rld004", kind: "html", x: 160, y: 600, w: 800, h: 200, rotation: 0, html: '<div id="out">first load</div>', css: "#out{font:48px sans-serif}", js: "if (location.hash !== '#again') { location.hash = 'again'; location.reload(); } else { document.getElementById('out').textContent = 'ran after reload'; }" },
  }]);
});

/** The text an HTML element's own script wrote, inside its sandboxed frame. */
const htmlOutput = (page: Page, element: string) => page.frameLocator(`.sp-el[data-sp-id="${element}"] iframe`).last().locator("#out");

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
  await expect(htmlOutput(page, "e_hre003")).toHaveText("HTML ran 2", { timeout: 15_000 });
  await page.keyboard.press("ArrowLeft");
  await expect(stage).toHaveAttribute("data-slide", "s_pre001");
  await expect(stage).toHaveAttribute("data-step", "1");
  await page.keyboard.press("End");
  await expect(stage).toHaveAttribute("data-slide", "s_pre004");
  // An element that reloads its own frame runs again after the reload.
  await expect(htmlOutput(page, "e_rld004")).toHaveText("ran after reload", { timeout: 15_000 });
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("End of the presentation.")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(stage).toHaveAttribute("data-slide", "s_pre001");
  await expect(page.getByRole("toolbar", { name: "Presentation" }).getByText("1 / 3")).toBeAttached();
});

test("normal presentation keeps its title and Exit visible without advancing from the bars", async () => {
  const { page } = me;
  await page.goto(`/decks/${deck}/present`);
  const stage = page.getByTestId("present-stage");
  const top = page.getByTestId("present-top-bar");
  await expect(top.getByRole("heading", { name: `Talk ${run}` })).toBeVisible();
  await top.getByRole("heading").click();
  await page.getByRole("toolbar", { name: "Presentation", exact: true }).getByText("1 / 3").click();
  await expect(stage).toHaveAttribute("data-step", "0");
  // The old 2.5-second idle timer must not hide the normal presentation chrome.
  await expect(page.locator("[data-idle]")).toBeAttached({ timeout: 5_000 });
  await expect(top).toHaveCSS("opacity", "1");
  await expect(top.getByRole("button", { name: "Exit presentation" })).toBeVisible();
});

test("full screen reveals each edge independently and leaves control activation to the focused button", async () => {
  const { page } = me;
  await page.goto(`/decks/${deck}/present`);
  const stage = page.getByTestId("present-stage");
  const top = page.getByTestId("present-top-bar");
  const bottom = page.getByRole("toolbar", { name: "Presentation", exact: true });
  await bottom.getByRole("button", { name: "Full screen", exact: true }).click();
  await expect(page.locator("[data-fullscreen]")).toBeAttached();
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await expect(top).toHaveCSS("opacity", "0");
  await expect(bottom).toHaveCSS("opacity", "0");
  await page.mouse.move(viewport.width / 2, 2);
  await expect(top).toHaveCSS("opacity", "1");
  await expect(bottom).toHaveCSS("opacity", "0");
  await page.mouse.move(viewport.width / 2, viewport.height - 2);
  await expect(top).toHaveCSS("opacity", "0");
  await expect(bottom).toHaveCSS("opacity", "1");
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  await top.getByRole("button", { name: "Exit presentation" }).focus();
  await expect(top).toHaveCSS("opacity", "1");
  await expect(bottom).toHaveCSS("opacity", "0");
  await bottom.getByRole("button", { name: "Leave full screen" }).focus();
  await expect(bottom).toHaveCSS("opacity", "1");
  await expect(top).toHaveCSS("opacity", "0");
  await page.keyboard.press("Space");
  await expect(page.locator("[data-fullscreen]")).toHaveCount(0);
  await expect(stage).toHaveAttribute("data-step", "0");
  await expect(top).toHaveCSS("opacity", "1");
  await expect(page).toHaveURL(new RegExp(`/decks/${deck}/present$`));
});

test("Escape leaves full screen first and Exit returns to the deck", async () => {
  const { page } = me;
  await page.goto(`/decks/${deck}/present`);
  await page.getByRole("button", { name: "Full screen", exact: true }).click();
  await expect(page.locator("[data-fullscreen]")).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-fullscreen]")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/decks/${deck}/present$`));
  await page.getByRole("button", { name: "Exit presentation" }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${deck}(\\?.*)?$`));
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
  const upcoming = presenter.getByRole("img", { name: "Next slide", exact: true });
  await expect(upcoming.frameLocator("iframe").locator("#out")).toHaveText("HTML ran 2");
  await expect(upcoming.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts");
  await presenter.getByRole("button", { name: "Next", exact: true }).click();
  await expect(presenter.getByTestId("speaker-notes")).toHaveText("This one runs code");
  await expect(page.getByTestId("present-stage")).toHaveAttribute("data-slide", "s_pre003");
  // The presenter's current slide runs its HTML elements too.
  await expect(htmlOutput(presenter, "e_hre003")).toHaveText("HTML ran 2", { timeout: 15_000 });

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
  // A follower sees the HTML element run: its script wrote its text inside the sandboxed frame.
  await expect(htmlOutput(follower, "e_hre003")).toHaveText("HTML ran 2", { timeout: 15_000 });
  await presenter.keyboard.press("ArrowRight");
  await expect(stage).toHaveAttribute("data-slide", "s_pre004", { timeout: 15_000 });
  // Present mode in the first window moved too.
  await expect(page.getByTestId("present-stage")).toHaveAttribute("data-slide", "s_pre004");

  await presenter.getByRole("button", { name: "End the follow link" }).click();
  await expect(follower.getByText("The presentation ended.")).toBeVisible({ timeout: 15_000 });
  await viewer.close();
  await presenter.close();
});

test("the history shows a version with its HTML elements running", async () => {
  const { page } = me;
  await page.goto(`/decks/${deck}/history`);
  await page.getByRole("list", { name: "Slides in this version" }).getByRole("button", { name: /^Slide 3/ }).click();
  await expect(htmlOutput(page, "e_hre003")).toHaveText("HTML ran 2", { timeout: 15_000 });
});

test("pages report no errors", async () => {
  expect(me.errors).toEqual([]);
});
