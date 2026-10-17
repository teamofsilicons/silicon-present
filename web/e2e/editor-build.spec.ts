/**
 * A Carbon builds a deck with every kind of element through the editor's own controls, and the service ends up with
 * exactly that deck: text (formatted), shapes, an image, a video, an audio clip, a table (resized, typed in, filled),
 * a chart (type and data changed), an HTML element (code edited, running), speaker notes, an animation, a transition,
 * a theme, a section, a skipped slide and a reordered slide.
 */
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createDeck, signedIn } from "./pages-support";
import { deckJson, openDeck, plain, settled } from "./editor-support";

const FIXTURES = resolve(__dirname, "../../renderer/test/fixtures");

async function selection(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __presentEditor: { ui: { get(): { selection: string[] } } } }).__presentEditor.ui.get().selection);
}

async function center(page: Page, id: string, dx = 0.5, dy = 0.5) {
  const box = (await page.locator(`[data-element-id="${id}"]`).first().boundingBox())!;
  return { x: box.x + box.width * dx, y: box.y + box.height * dy };
}

/** Puts the selected element at (x, y) through the position fields. */
async function place(page: Page, x: number, y: number) {
  for (const [label, value] of [["X", x], ["Y", y]] as const) {
    const field = page.getByLabel(label, { exact: true });
    await field.fill(String(value));
    await field.press("Enter");
  }
}

async function typeInto(page: Page, id: string, text: string, at = { dx: 0.5, dy: 0.5 }) {
  const p = await center(page, id, at.dx, at.dy);
  await page.mouse.dblclick(p.x, p.y);
  await page.locator('[data-testid="text-editor"] .ql-editor').waitFor();
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

test("a Carbon builds a deck with every element kind through the editor", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, errors } = await signedIn(browser, "carbon");
  const deck = await createDeck(context, "Every element");
  await openDeck(page, deck);

  // The new deck's title slide: type the title into its placeholder.
  const first = await page.evaluate(() => (window as unknown as { __presentEditor: { deck(): { slides: Array<{ elements: Array<{ id: string }> }> } } }).__presentEditor.deck().slides[0]!.elements.map(e => e.id));
  await typeInto(page, first[0]!, "Quarterly review");
  await typeInto(page, first[1]!, "Made in the editor");

  // A second slide from the layout picker.
  await page.getByTestId("new-slide").click();
  await page.getByRole("button", { name: "Blank" }).click();
  await expect(page.getByTestId("slide-thumb")).toHaveCount(2);

  // Text, with bold.
  await page.getByTestId("insert-text").click();
  await page.locator('[data-testid="text-editor"] .ql-editor').waitFor();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+b" : "Control+b");
  await page.keyboard.type("Bold words");
  await page.keyboard.press("Escape");
  const [textId] = await selection(page);
  await place(page, 100, 80);

  // Shapes: a star and an ellipse with text inside.
  await page.getByTestId("insert-shape").click();
  await page.locator('[data-shape="star"]').click();
  const [starId] = await selection(page);
  await place(page, 100, 300);
  await page.getByTestId("insert-shape").click();
  await page.locator('[data-shape="ellipse"]').click();
  const [ellipseId] = await selection(page);
  await place(page, 1300, 80);
  await typeInto(page, ellipseId!, "Inside");

  // Image, video and audio, uploaded.
  await page.getByTestId("file-input").setInputFiles(resolve(FIXTURES, "picture.png"));
  await expect.poll(async () => (await page.locator('[data-kind="image"]').count())).toBe(1);
  await place(page, 520, 300);
  await page.getByTestId("file-input").setInputFiles(resolve(FIXTURES, "clip.mp4"));
  await expect.poll(async () => (await page.locator('[data-kind="video"]').count())).toBe(1);
  await place(page, 1000, 420);
  await page.getByTestId("file-input").setInputFiles(resolve(FIXTURES, "tone.mp3"));
  await expect.poll(async () => (await page.locator('[data-kind="audio"]').count())).toBe(1);
  await place(page, 100, 900);

  // A table: 3 x 3, then a row and a column more, a cell typed in and filled.
  await page.getByTestId("insert-table").click();
  await page.getByRole("button", { name: "3 by 3 table" }).click();
  const [tableId] = await selection(page);
  await place(page, 700, 640);
  await page.getByTestId("table-add-row").click();
  await page.getByTestId("table-add-col").click();
  await typeInto(page, tableId!, "Cell text", { dx: 0.1, dy: 0.1 });
  await page.getByRole("button", { name: /^Cell fill/ }).click();
  await page.getByRole("button", { name: "Accent", exact: true }).click();

  // A chart: a line chart with a changed value.
  await page.getByTestId("insert-chart").click();
  const [chartId] = await selection(page);
  await place(page, 1300, 420);
  await page.getByLabel("Chart type").selectOption("line");
  const cell = page.getByLabel("2026, Q2");
  await cell.fill("42");
  await cell.press("Enter");

  // An HTML element whose code is edited; it runs.
  await page.getByTestId("insert-html").click();
  const [htmlId] = await selection(page);
  await page.getByTestId("code-html").fill('<h1 id="hi">Built by hand</h1>');
  await expect(page.frameLocator(`[data-element-id="${htmlId}"] iframe`).locator("#hi")).toHaveText("Built by hand", { timeout: 20_000 });
  await page.getByRole("button", { name: "Close the code" }).click();

  // Speaker notes.
  await page.getByTestId("speaker-notes").fill("Say why the numbers moved");

  // An animation on the text, a transition on the slide.
  await page.mouse.click(...Object.values(await center(page, textId!)) as [number, number]);
  await page.getByTestId("tab-animate").click();
  await page.getByLabel("Effect", { exact: true }).selectOption("fade");
  await page.getByLabel("Transition").selectOption("push");
  await page.getByTestId("tab-theme").click();
  await page.getByTestId("theme-option").filter({ hasText: "Ivory" }).click();

  // Skip the first slide and start a section at it, from the slide list's menu.
  await page.getByTestId("slide-thumb").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Skip slide" }).click();
  await page.getByTestId("slide-thumb").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Start a section here" }).click();
  await page.getByLabel("Section name").fill("Opening");
  await page.getByLabel("Section name").press("Enter");

  // Reorder: drag the second slide above the first.
  await page.getByTestId("slide-thumb").nth(1).dragTo(page.getByTestId("slide-thumb").first(), { targetPosition: { x: 40, y: 5 } });

  await settled(page);
  await expect
    .poll(async () => {
      const json = await deckJson(context, deck);
      return json.slides.length === 2 && json.slides[1]!.skipped && json.slides[0]!.elements.length >= 8;
    }, { timeout: 20_000 })
    .toBe(true);
  const json = await deckJson(context, deck);
  const built = json.slides[0]!;
  const opening = json.slides[1]!;
  expect(plain(opening.elements[0]!.text)).toBe("Quarterly review");
  expect(plain(opening.elements[1]!.text)).toBe("Made in the editor");
  expect(opening.skipped).toBe(true);
  expect(opening.section).toBe("Opening");
  const byId = new Map(built.elements.map(e => [e.id, e]));
  const kinds = new Set(built.elements.map(e => e.kind));
  for (const kind of ["text", "shape", "image", "video", "audio", "table", "chart", "html"]) expect(kinds, `a ${kind} element`).toContain(kind);
  const text = byId.get(textId!)!;
  expect(plain(text.text)).toBe("Bold words");
  expect((text.text as { paragraphs: Array<{ runs: Array<{ bold?: boolean }> }> }).paragraphs[0]!.runs[0]!.bold).toBe(true);
  expect(text.animation).toMatchObject({ effect: "fade", trigger: "click" });
  expect(byId.get(starId!)).toMatchObject({ shape: "star" });
  expect(plain(byId.get(ellipseId!)!.text)).toBe("Inside");
  expect(byId.get(ellipseId!)).toMatchObject({ x: 1300, y: 80 });
  for (const kind of ["image", "video", "audio"]) expect(String(built.elements.find(e => e.kind === kind)!.src)).toMatch(/^asset:/);
  const table = byId.get(tableId!) as unknown as { rows: number; cols: number; cells: Array<Array<{ text: unknown; fill: string | null }>> };
  expect(table.rows).toBe(4);
  expect(table.cols).toBe(4);
  expect(plain(table.cells[0]![0]!.text)).toBe("Cell text");
  expect(table.cells[0]![0]!.fill).toBeTruthy();
  const chart = byId.get(chartId!) as unknown as { chart: { type: string; series: Array<{ values: number[] }> } };
  expect(chart.chart.type).toBe("line");
  expect(chart.chart.series[0]!.values[1]).toBe(42);
  expect(byId.get(htmlId!)!.html).toBe('<h1 id="hi">Built by hand</h1>');
  expect(built.notes).toBe("Say why the numbers moved");
  expect(built.transition).toMatchObject({ type: "push" });
  expect(json.theme.name).toBe("Ivory");
  expect(errors).toEqual([]);
  await context.close();
});
