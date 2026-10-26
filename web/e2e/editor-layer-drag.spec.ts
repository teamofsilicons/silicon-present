import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDeck, edit, signedIn } from "./pages-support";
import { deckJson, openDeck, settled } from "./editor-support";

const id = (n: number) => `e_drag${String(n).padStart(2, "0")}`;
type EditorWindow = { __presentEditor: { deck(): { slides: Array<{ elements: Array<{ id: string }> }> }; ui: { get(): { selection: string[] } } } };
const order = (page: Page) => page.evaluate(() => (window as unknown as EditorWindow).__presentEditor.deck().slides[0]!.elements.map(element => element.id));
const selected = (page: Page) => page.evaluate(() => (window as unknown as EditorWindow).__presentEditor.ui.get().selection);
const panel = (page: Page) => page.getByRole("dialog", { name: "Layers", exact: true });
const row = (page: Page, n: number) => panel(page).locator(`button[data-layer-id="${id(n)}"]`);

async function fixture(context: BrowserContext, title: string, count = 6) {
  const deck = await createDeck(context, title);
  const first = (await deckJson(context, deck)).slides[0]!;
  await edit(context, deck, [
    ...first.elements.map(element => ({ op: "delete_element", slide: first.id, element: element.id })),
    { op: "update_slide", slide: first.id, set: { layout: "blank" } },
    ...Array.from({ length: count }, (_, i) => ({ op: "add_element", slide: first.id, element: {
      id: id(i + 1), kind: "text", x: 80, y: 60 + i * 12, w: 500, h: 60,
      text: { paragraphs: [{ runs: [{ text: i === 0 ? "A long layer label that must truncate within the list instead of widening the draggable row" : `Layer ${i + 1}` }] }] },
    } })),
  ]);
  return { deck, slide: first.id, ids: Array.from({ length: count }, (_, i) => id(i + 1)) };
}

async function dragTo(page: Page, source: number, target: number, edge: "before" | "after") {
  const from = (await row(page, source).boundingBox())!;
  const to = (await row(page, target).boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 45, edge === "before" ? to.y + 3 : to.y + to.height - 3, { steps: 8 });
  await expect(page.getByTestId("layer-drag-preview")).toBeVisible();
}

test("row drag moves a multi-selection once, preserves clicks, and Escape/outside drops cancel", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const data = await fixture(context, "Drag selected layers");
  await openDeck(page, data.deck);
  await page.getByTestId("layers-control").click();
  const bounds = (await panel(page).getByRole("list").boundingBox())!;
  const long = (await row(page, 1).boundingBox())!;
  expect(long.x + long.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
  await row(page, 2).click();
  await row(page, 4).click({ modifiers: ["Shift"] });
  await expect.poll(async () => (await selected(page)).sort()).toEqual([id(2), id(4)]);
  await dragTo(page, 2, 6, "before");
  await expect(page.getByTestId("layer-drag-preview")).toContainText("2 layers");
  await expect(panel(page).locator('li[data-drop="before"] button')).toHaveAttribute("data-layer-id", id(6));
  expect(await order(page)).toEqual(data.ids);
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([id(1), id(3), id(5), id(6), id(2), id(4)]);
  await expect.poll(async () => (await selected(page)).sort()).toEqual([id(2), id(4)]);
  await expect(page.getByTestId("layer-drag-preview")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("undo").click();
  await expect.poll(() => order(page)).toEqual(data.ids);
  await page.getByTestId("layers-control").click();

  await dragTo(page, 1, 6, "before");
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("layer-drag-preview")).toHaveCount(0);
  await page.mouse.up();
  expect(await order(page)).toEqual(data.ids);
  await dragTo(page, 1, 6, "before");
  const outside = (await panel(page).boundingBox())!;
  await page.mouse.move(outside.x - 80, outside.y + 80);
  await expect(page.getByTestId("layer-drop-marker")).toHaveCount(0);
  await page.mouse.up();
  expect(await order(page)).toEqual(data.ids);

  await row(page, 3).dblclick();
  await expect(page.locator('[data-testid="text-editor"] .ql-editor')).toBeFocused();
  expect(errors).toEqual([]);
  await context.close();
});

test("dragging a group uses atomic target boundaries and locked rows never start a drag", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const data = await fixture(context, "Grouped layer drops");
  await edit(context, data.deck, [
    ...[2, 3].map(n => ({ op: "update_element", slide: data.slide, element: id(n), set: { group: "g_source" } })),
    ...[4, 5].map(n => ({ op: "update_element", slide: data.slide, element: id(n), set: { group: "g_target" } })),
    { op: "update_element", slide: data.slide, element: id(6), set: { locked: true } },
  ]);
  await openDeck(page, data.deck);
  await page.getByTestId("layers-control").click();
  await dragTo(page, 2, 4, "before");
  await expect(panel(page).locator('li[data-drop="before"] button')).toHaveAttribute("data-layer-id", id(5));
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual([id(1), id(4), id(5), id(2), id(3), id(6)]);
  await expect.poll(async () => (await selected(page)).sort()).toEqual([id(2), id(3)]);
  const beforeLocked = await order(page);
  await expect(row(page, 6)).not.toHaveAttribute("data-draggable", "true");
  const locked = (await row(page, 6).boundingBox())!, target = (await row(page, 1).boundingBox())!;
  await page.mouse.move(locked.x + 20, locked.y + 15); await page.mouse.down();
  await page.mouse.move(target.x + 20, target.y + 20, { steps: 6 });
  await expect(page.getByTestId("layer-drag-preview")).toHaveCount(0);
  await page.mouse.up();
  expect(await order(page)).toEqual(beforeLocked);
  expect(errors).toEqual([]);
  await context.close();
});

test("a layer row's object menu is above the panel and its Group action really groups the selection", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const data = await fixture(context, "Layer menu stacking");
  await openDeck(page, data.deck);
  await page.getByTestId("layers-control").click();
  await row(page, 2).click();
  await row(page, 4).click({ modifiers: ["Shift"] });
  await row(page, 2).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Object actions" });
  const group = menu.getByRole("menuitem", { name: /^Group/ });
  await expect(menu).toBeVisible();
  await group.scrollIntoViewIfNeeded();
  // Visibility alone also passes when the entire menu paints underneath its owning popover.
  await expect.poll(() => group.evaluate(item => {
    const box = item.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return topmost === item || item.contains(topmost);
  })).toBe(true);
  await group.click(); // No forced click: the visible menu must receive the real pointer event.
  await expect(menu).toHaveCount(0);
  await expect(row(page, 2)).toHaveAttribute("aria-label", /grouped/);
  await expect(row(page, 4)).toHaveAttribute("aria-label", /grouped/);
  await settled(page);
  await expect.poll(async () => {
    const elements = (await deckJson(context, data.deck)).slides[0]!.elements;
    const groupId = elements.find(element => element.id === id(2))?.group;
    return typeof groupId === "string" && groupId.length > 0
      && elements.find(element => element.id === id(4))?.group === groupId
      && elements.filter(element => ![id(2), id(4)].includes(element.id)).every(element => element.group !== groupId);
  }).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});

test("long layer lists scroll at the drag edge and can cancel without reordering", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const data = await fixture(context, "Scrolling layer drag", 40);
  await openDeck(page, data.deck);
  await page.getByTestId("layers-control").click();
  const list = panel(page).getByRole("list");
  const source = (await row(page, 40).boundingBox())!, bounds = (await list.boundingBox())!;
  await page.mouse.move(source.x + 20, source.y + 15); await page.mouse.down();
  await page.mouse.move(bounds.x + 40, bounds.y + bounds.height - 4, { steps: 8 });
  await expect(page.getByTestId("layer-drag-preview")).toBeVisible();
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(30);
  await page.keyboard.press("Escape"); await page.mouse.up();
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("layer-drag-preview")).toHaveCount(0);
  expect(await order(page)).toEqual(data.ids);
  expect(errors).toEqual([]);
  await context.close();
});
