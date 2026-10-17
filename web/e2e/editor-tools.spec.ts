/**
 * The editor's tools: undo and redo (only your own changes), find and replace across slides, cells and notes (keeping
 * formatting), snapping to other elements with visible guides, copy and paste into another deck, keyboard nudging,
 * duplicating and deleting, grouping, locking, and the shortcuts dialog.
 */
import { expect, test, type Page } from "@playwright/test";
import { call, createDeck, edit, eventually, signedIn } from "./pages-support";
import { deckJson, openDeck, plain, settled } from "./editor-support";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

type W = { __presentEditor: { deck(): { slides: Array<{ id: string; elements: Array<{ id: string; kind: string; x: number; y: number; w: number; h: number; locked: boolean; group: string | null }> }> }; ui: { get(): { selection: string[]; slideId: string | null } } } };

async function elements(page: Page) {
  return page.evaluate(() => {
    const e = (window as unknown as W).__presentEditor;
    const slide = e.deck().slides.find(s => s.id === e.ui.get().slideId) ?? e.deck().slides[0]!;
    return slide.elements;
  });
}

async function selection(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as W).__presentEditor.ui.get().selection);
}

async function pagePoint(page: Page, x: number, y: number) {
  const box = (await page.getByTestId("slide-canvas").boundingBox())!;
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

test("undo and redo, find and replace", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const deck = await createDeck(context, "Tools");
  const slide = (await call<{ slides: Array<{ id: string }> }>(context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
  await edit(context, deck, [
    { op: "update_slide", slide, set: { notes: "Mention the old plan twice: old plan." } },
    { op: "add_element", slide, element: { id: "e_findme", kind: "text", x: 100, y: 700, w: 1200, h: 120, text: { paragraphs: [{ runs: [{ text: "The " }, { text: "old plan", bold: true }, { text: " is here" }] }] } } },
    { op: "add_element", slide, element: { id: "e_tbl001", kind: "table", x: 1300, y: 600, w: 500, h: 200, rows: 2, cols: 2, cells: [[{ text: { paragraphs: [{ runs: [{ text: "old plan cell" }] }] } }, { text: { paragraphs: [] } }], [{ text: { paragraphs: [] } }, { text: { paragraphs: [] } }]] } },
  ]);
  await openDeck(page, deck);

  // Undo and redo an insert.
  await page.getByTestId("insert-shape").click();
  await page.locator('[data-shape="diamond"]').click();
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(1);
  await page.mouse.click(5, 300);
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(1);
  // The toolbar's buttons do the same.
  await page.getByTestId("undo").click();
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(0);
  await page.getByTestId("redo").click();
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(1);

  // Undo only undoes this Carbon's own changes: a change the service makes meanwhile stays.
  await edit(context, deck, [{ op: "add_element", slide, element: { id: "e_otherx", kind: "shape", shape: "plus", x: 1600, y: 60, w: 160, h: 160 } }]);
  await expect(page.locator('[data-element-id="e_otherx"]')).toBeVisible();
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(1);
  await expect(page.locator('[data-element-id="e_otherx"]')).toBeVisible();

  // Find and replace across text, a table cell and the notes, keeping the bold.
  await page.keyboard.press(`${MOD}+f`);
  await page.getByTestId("find-input").fill("old plan");
  await expect(page.getByTestId("find-panel")).toContainText("1 of 4");
  await page.getByTestId("replace-input").fill("new plan");
  await page.getByTestId("replace-all").click();
  await expect(page.getByTestId("find-panel")).toContainText("Replaced 4.");
  await settled(page);
  await eventually(async () => {
    const json = await deckJson(context, deck);
    const s = json.slides[0]!;
    expect(s.notes).toBe("Mention the new plan twice: new plan.");
    const text = s.elements.find(e => e.id === "e_findme")!.text as { paragraphs: Array<{ runs: Array<{ text: string; bold?: boolean }> }> };
    expect(plain(text)).toBe("The new plan is here");
    expect(text.paragraphs[0]!.runs.find(r => r.text.includes("new plan"))?.bold).toBe(true);
    const cells = s.elements.find(e => e.id === "e_tbl001")!.cells as Array<Array<{ text: unknown }>>;
    expect(plain(cells[0]![0]!.text)).toBe("new plan cell");
  });
  // One step undoes the whole replace.
  await page.getByTestId("find-panel").getByRole("button", { name: "Close find and replace" }).click();
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator('[data-element-id="e_findme"]')).toContainText("The old plan is here");
  expect(errors).toEqual([]);
  await context.close();
});

test("snapping with guides, keyboard editing, grouping, locking, copy and paste into another deck", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const deck = await createDeck(context, "Arrange");
  const other = await createDeck(context, "Paste here");
  const slide = (await call<{ slides: Array<{ id: string }> }>(context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
  await edit(context, deck, [
    { op: "delete_element", slide, element: (await deckJson(context, deck)).slides[0]!.elements[0]!.id },
    { op: "delete_element", slide, element: (await deckJson(context, deck)).slides[0]!.elements[1]!.id },
    { op: "add_element", slide, element: { id: "e_anchor", kind: "shape", shape: "rect", x: 300, y: 200, w: 300, h: 200 } },
    { op: "add_element", slide, element: { id: "e_mover1", kind: "shape", shape: "ellipse", x: 1000, y: 600, w: 300, h: 200 } },
  ]);
  await openDeck(page, deck);

  // Drag the ellipse close to the rectangle's left edge: it snaps exactly, and a guide shows while dragging.
  const from = await pagePoint(page, 1150, 700);
  const to = await pagePoint(page, 450 + 9, 700);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(page.getByTestId("snap-guide").first()).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId("snap-guide")).toHaveCount(0);
  await eventually(async () => {
    const mover = (await elements(page)).find(e => e.id === "e_mover1")!;
    expect(mover.x).toBe(300);
  });

  // Arrows nudge (1 px, 10 px with shift).
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await eventually(async () => {
    const mover = (await elements(page)).find(e => e.id === "e_mover1")!;
    expect([mover.x, mover.y]).toEqual([301, 610]);
  });

  // Duplicate, then delete the copy.
  await page.keyboard.press(`${MOD}+d`);
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(3);
  await page.keyboard.press("Delete");
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(2);

  // Select both (marquee), group, then a click selects the group; lock stops it moving.
  const m1 = await pagePoint(page, 100, 100);
  const m2 = await pagePoint(page, 1500, 1000);
  await page.mouse.move(m1.x, m1.y);
  await page.mouse.down();
  await page.mouse.move(m2.x, m2.y, { steps: 8 });
  await page.mouse.up();
  expect((await selection(page)).sort()).toEqual(["e_anchor", "e_mover1"]);
  await page.keyboard.press(`${MOD}+g`);
  await eventually(async () => {
    const els = await elements(page);
    expect(els.every(e => e.group && e.group === els[0]!.group)).toBe(true);
  });
  await page.keyboard.press("Escape");
  const a = await pagePoint(page, 450, 300);
  await page.mouse.click(a.x, a.y);
  expect((await selection(page)).sort()).toEqual(["e_anchor", "e_mover1"]);
  await page.keyboard.press(`${MOD}+Shift+l`);
  await page.keyboard.press("ArrowRight");
  await eventually(async () => {
    const els = await elements(page);
    expect(els.every(e => e.locked)).toBe(true);
    expect(els.find(e => e.id === "e_anchor")!.x).toBe(300);
  });
  await page.keyboard.press(`${MOD}+Shift+l`);
  await page.keyboard.press(`${MOD}+Shift+g`);
  await eventually(async () => expect((await elements(page)).every(e => !e.group && !e.locked)).toBe(true));

  // Copy the rectangle, paste it into the other deck in the same browser.
  await page.keyboard.press("Escape");
  await page.mouse.click(a.x, a.y);
  await page.keyboard.press(`${MOD}+c`);
  await openDeck(page, other);
  await page.mouse.click(5, 300);
  await page.keyboard.press(`${MOD}+v`);
  await eventually(async () => {
    const els = await elements(page);
    expect(els.some(e => e.kind === "shape" && e.x === 300 && e.w === 300)).toBe(true);
  });
  await settled(page);
  await eventually(async () => {
    const json = await deckJson(context, other);
    expect(json.slides[0]!.elements.some(e => e.kind === "shape" && e.shape === "rect")).toBe(true);
  });

  // The shortcuts dialog.
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  expect(errors).toEqual([]);
  await context.close();
});

test("the master: what is put there shows under every slide that shows it", async ({ browser }) => {
  const { context, page, errors } = await signedIn(browser, "carbon");
  const deck = await createDeck(context, "Master");
  await openDeck(page, deck);
  await page.getByTestId("new-slide").click();
  await page.getByRole("dialog").getByRole("button", { name: "Blank" }).click();
  await page.getByTestId("edit-master").click();
  await expect(page.getByRole("button", { name: "Editing the master · Done" })).toBeVisible();
  await page.getByTestId("insert-shape").click();
  await page.locator('[data-shape="rect"]').click();
  for (const [label, value] of [["X", "40"], ["Y", "1000"], ["W", "1840"], ["H", "40"]] as const) {
    await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel(label, { exact: true }).press("Enter");
  }
  await page.getByRole("button", { name: "Editing the master · Done" }).click();
  // The footer bar is drawn (not selectable) on the slide, and hiding the master on a slide takes it away.
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(1);
  await page.getByRole("checkbox", { name: "Show the master" }).uncheck();
  await expect(page.locator('[data-kind="shape"]')).toHaveCount(0);
  await settled(page);
  await eventually(async () => {
    const json = await deckJson(context, deck);
    expect((json.master.elements as Array<{ kind: string; y: number }>).some(e => e.kind === "shape" && e.y === 1000)).toBe(true);
    expect(json.slides.filter(s => (s as unknown as { hideMaster: boolean }).hideMaster).length).toBe(1);
  });
  expect(errors).toEqual([]);
  await context.close();
});
