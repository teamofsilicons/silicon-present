import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDeck, edit, signedIn } from "./pages-support";
import { deckJson, openDeck, settled, share } from "./editor-support";
import { runAccounts } from "./support";

const BACK = "e_layerb", TEXT = "e_layert", FRONT = "e_layerf";
type EditorWindow = { __presentEditor: { ui: { get(): { selection: string[]; codeElement: string | null } } } };
const selection = (page: Page) => page.evaluate(() => (window as unknown as EditorWindow).__presentEditor.ui.get().selection);

async function overlappingDeck(context: BrowserContext, title: string) {
  const id = await createDeck(context, title);
  const first = (await deckJson(context, id)).slides[0]!;
  await edit(context, id, [
    ...first.elements.map(element => ({ op: "delete_element", slide: first.id, element: element.id })),
    { op: "update_slide", slide: first.id, set: { layout: "blank" } },
    { op: "add_element", slide: first.id, element: { id: BACK, kind: "shape", shape: "ellipse", x: 400, y: 300, w: 700, h: 300, style: { fill: "#4277C5" } } },
    { op: "add_element", slide: first.id, element: { id: TEXT, kind: "text", x: 400, y: 300, w: 700, h: 300, text: { paragraphs: [{ runs: [{ text: "Hidden title", size: 48 }] }] } } },
    { op: "add_element", slide: first.id, element: { id: FRONT, kind: "shape", shape: "rect", x: 400, y: 300, w: 700, h: 300, style: { fill: "#E58D68" } } },
  ]);
  return { id, slide: first.id };
}

async function point(page: Page, x = 700, y = 420) {
  const box = (await page.getByTestId("slide-canvas").boundingBox())!;
  return { x: box.x + box.width * x / 1920, y: box.y + box.height * y / 1080 };
}

test("right-click orders objects, Layers selects obscured text, and editing stays on double-click", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const deck = await overlappingDeck(context, "Layer ordering and editing");
  await openDeck(page, deck.id);
  const at = await point(page);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.getByRole("menu", { name: "Object actions" });
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("text-editor")).toHaveCount(0);
  await expect.poll(() => selection(page)).toEqual([FRONT]);
  await menu.getByRole("menuitem", { name: /^Send to back/ }).click();
  await settled(page);
  await expect.poll(async () => (await deckJson(context, deck.id)).slides[0]!.elements.map(element => element.id)).toEqual([FRONT, BACK, TEXT]);
  await page.getByTestId("undo").click();
  await settled(page);
  await expect.poll(async () => (await deckJson(context, deck.id)).slides[0]!.elements.map(element => element.id)).toEqual([BACK, TEXT, FRONT]);

  await page.getByTestId("layers-control").click();
  const layers = page.getByRole("dialog", { name: "Layers", exact: true });
  await expect(layers).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(layers.locator("button[data-layer-id]")).toHaveText(["Rectangle", "Hidden title", "Ellipse"]);
  const hidden = layers.locator(`[data-layer-id="${TEXT}"]`);
  await hidden.click();
  await expect(hidden).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => selection(page)).toEqual([TEXT]);
  await layers.getByTestId("layer-front").click();
  await settled(page);
  await expect.poll(async () => (await deckJson(context, deck.id)).slides[0]!.elements.map(element => element.id)).toEqual([BACK, FRONT, TEXT]);
  await expect(layers.getByTestId("layer-front")).toBeDisabled();

  await hidden.focus();
  await hidden.click({ button: "right" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(layers).toBeVisible();
  await expect(hidden).toBeFocused();
  await hidden.click({ button: "right" });
  await menu.getByRole("menuitem", { name: /^Edit text/ }).click();
  await expect(layers).toHaveCount(0);
  await expect(page.getByTestId("layers-control")).toHaveAttribute("data-state", "closed");
  const textEditor = page.locator('[data-testid="text-editor"] .ql-editor');
  await expect(textEditor).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(textEditor).toHaveCount(0);
  await page.mouse.dblclick(at.x, at.y);
  await expect(textEditor).toBeVisible();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("layers-control").click();
  await page.keyboard.press("Escape");
  await expect(layers).toHaveCount(0);
  await expect(page.getByTestId("layers-control")).toBeFocused();
  expect(errors).toEqual([]);
  await context.close();
});

test("layer row menus preserve multi-selection and protect locked groups and HTML", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const deck = await overlappingDeck(context, "Protected layers");
  await edit(context, deck.id, [
    { op: "update_element", slide: deck.slide, element: BACK, set: { group: "g_locked" } },
    { op: "update_element", slide: deck.slide, element: FRONT, set: { group: "g_locked", locked: true } },
    { op: "add_element", slide: deck.slide, element: { id: "e_lockht", kind: "html", x: 1300, y: 300, w: 400, h: 300, locked: true, html: "<p>Locked</p>", css: "", js: "" } },
  ]);
  await openDeck(page, deck.id);
  const before = (await deckJson(context, deck.id)).slides[0]!.elements;
  await page.getByTestId("layers-control").click();
  const layers = page.getByRole("dialog", { name: "Layers", exact: true });
  const back = layers.locator(`[data-layer-id="${BACK}"]`);
  await back.click();
  await expect.poll(async () => (await selection(page)).sort()).toEqual([BACK, FRONT].sort());
  for (const to of ["front", "forward", "backward", "back"]) await expect(layers.getByTestId(`layer-${to}`)).toBeDisabled();
  await layers.locator(`[data-layer-id="${TEXT}"]`).click({ modifiers: ["Shift"] });
  await back.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Object actions" });
  await expect.poll(async () => (await selection(page)).sort()).toEqual([BACK, TEXT, FRONT].sort());
  await expect(menu.getByRole("menuitem", { name: /^Delete/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /^Cut/ })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: /^Ungroup/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(layers).toHaveCount(0);
  const at = await point(page, 1500, 450);
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).__presentEditor.ui.get().codeElement)).toBeNull();
  await settled(page);
  expect((await deckJson(context, deck.id)).slides[0]!.elements).toEqual(before);
  expect(errors).toEqual([]);
  await context.close();
});

test("viewers can inspect and select layers but cannot change their order or edit them", async ({ browser }) => {
  const owner = await signedIn(browser, "carbon");
  const deck = await overlappingDeck(owner.context, "View-only layers");
  await share(owner.context, deck.id, runAccounts().friend.id, "viewer");
  const viewer = await signedIn(browser, "friend");
  await openDeck(viewer.page, deck.id);
  const before = (await deckJson(owner.context, deck.id)).slides[0]!.elements;
  await viewer.page.getByTestId("layers-control").click();
  const layers = viewer.page.getByRole("dialog", { name: "Layers", exact: true });
  const hidden = layers.locator(`[data-layer-id="${TEXT}"]`);
  await hidden.click();
  await expect.poll(() => selection(viewer.page)).toEqual([TEXT]);
  for (const to of ["front", "forward", "backward", "back"]) await expect(layers.getByTestId(`layer-${to}`)).toBeDisabled();
  await hidden.click({ button: "right" });
  const menu = viewer.page.getByRole("menu", { name: "Object actions" });
  await expect(menu.getByRole("menuitem", { name: /^Copy/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Edit|^Bring|^Send|^Delete|^Cut|^Lock/ })).toHaveCount(0);
  await viewer.page.keyboard.press("Escape");
  await hidden.dblclick();
  await expect(viewer.page.getByTestId("text-editor")).toHaveCount(0);
  expect((await deckJson(owner.context, deck.id)).slides[0]!.elements).toEqual(before);
  expect(viewer.errors).toEqual([]);
  await viewer.context.close();
  await owner.context.close();
});
