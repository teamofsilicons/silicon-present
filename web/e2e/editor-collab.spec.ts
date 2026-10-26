/**
 * Editing together: two Carbons in the same deck at once see each other (avatars, selections, cursors) and each
 * other's changes; typing into the same text box at the same time merges; a Carbon who goes offline keeps editing and
 * everything merges when they're back (and survives closing the tab while offline, through IndexedDB); a Silicon's
 * change through the ops API appears at once, highlighted with its name.
 */
import { expect, test, type Page } from "@playwright/test";
import { createDeck, eventually, signedIn } from "./pages-support";
import { runAccounts } from "./support";
import { deckJson, drawArmedShape, openDeck, plain, settled, share, silicon } from "./editor-support";

type W = { __presentEditor: { deck(): { slides: Array<{ id: string; elements: Array<{ id: string; kind: string }> }> }; ui: { get(): { selection: string[] } } } };

async function elementIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as W).__presentEditor.deck().slides[0]!.elements.map(e => e.id));
}

async function dblclickElement(page: Page, id: string, dx = 0.5, dy = 0.5) {
  const box = (await page.locator(`[data-element-id="${id}"]`).first().boundingBox())!;
  await page.mouse.dblclick(box.x + box.width * dx, box.y + box.height * dy);
  await page.locator('[data-testid="text-editor"] .ql-editor').waitFor();
}

test("two Carbons edit the same deck at once and see each other", async ({ browser }) => {
  test.setTimeout(180_000);
  const ada = await signedIn(browser, "carbon");
  const bo = await signedIn(browser, "friend");
  const deck = await createDeck(ada.context, "Together");
  await share(ada.context, deck, runAccounts().friend.id, "editor");
  await openDeck(ada.page, deck);
  await openDeck(bo.page, deck);
  const [title, subtitle] = await elementIds(ada.page);

  // Presence: each sees the other in the top bar.
  await expect(ada.page.locator(`[data-person="${runAccounts().friend.id}"]`)).toBeVisible();
  await expect(bo.page.locator(`[data-person="${runAccounts().carbon.id}"]`)).toBeVisible();

  // Bo selects the title: Ada sees Bo's selection outline and cursor on the canvas.
  const box = (await bo.page.locator(`[data-element-id="${title}"]`).boundingBox())!;
  await bo.page.mouse.move(box.x + 20, box.y + 20);
  await bo.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(ada.page.getByTestId("remote-selection")).toBeVisible();
  await expect(ada.page.getByTestId("remote-cursor")).toBeVisible();

  // Ada types the title; Bo sees it.
  await dblclickElement(ada.page, title!);
  await ada.page.keyboard.type("Plan for the launch");
  await ada.page.keyboard.press("Escape");
  await expect(bo.page.locator(`[data-element-id="${title}"]`)).toContainText("Plan for the launch");

  // Both type into the subtitle at the same time: both passages survive, in both pages and in the service.
  await dblclickElement(ada.page, subtitle!);
  await dblclickElement(bo.page, subtitle!);
  await Promise.all([ada.page.keyboard.type("ada was here ", { delay: 35 }), bo.page.keyboard.type("bo too ", { delay: 35 })]);
  await ada.page.keyboard.press("Escape");
  await bo.page.keyboard.press("Escape");
  for (const page of [ada.page, bo.page]) {
    await expect(page.locator(`[data-element-id="${subtitle}"]`)).toContainText("ada was here");
    await expect(page.locator(`[data-element-id="${subtitle}"]`)).toContainText("bo too");
  }
  await settled(ada.page);
  await settled(bo.page);
  await eventually(async () => {
    const text = plain((await deckJson(ada.context, deck)).slides[0]!.elements.find(e => e.id === subtitle)!.text);
    expect(text).toContain("ada was here");
    expect(text).toContain("bo too");
  });
  const adaText = await ada.page.locator(`[data-element-id="${subtitle}"]`).innerText();
  const boText = await bo.page.locator(`[data-element-id="${subtitle}"]`).innerText();
  expect(adaText).toBe(boText);

  // Bo goes offline and keeps working; Ada edits meanwhile; everything merges once Bo is back.
  await bo.context.setOffline(true);
  await expect(bo.page.getByTestId("connection-status")).toHaveAttribute("data-status", "offline", { timeout: 20_000 });
  await bo.page.getByTestId("choose-shape").click();
  await bo.page.getByRole("menuitem", { name: "More shapes", exact: true }).click();
  await bo.page.locator('[data-shape="hexagon"]').click();
  await drawArmedShape(bo.page);
  await bo.page.getByTestId("speaker-notes").fill("Written offline");
  await dblclickElement(ada.page, title!, 0.95, 0.5);
  await ada.page.keyboard.press("End");
  await ada.page.keyboard.type(" (draft)");
  await ada.page.keyboard.press("Escape");
  await expect(ada.page.locator('[data-kind="shape"]')).toHaveCount(0);
  await bo.context.setOffline(false);
  await expect(ada.page.locator('[data-kind="shape"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(bo.page.locator(`[data-element-id="${title}"]`)).toContainText("Plan for the launch (draft)", { timeout: 30_000 });
  await expect(ada.page.getByTestId("speaker-notes")).toHaveValue("Written offline");
  await settled(bo.page);
  await eventually(async () => {
    const json = await deckJson(ada.context, deck);
    expect(json.slides[0]!.notes).toBe("Written offline");
    expect(json.slides[0]!.elements.some(e => e.kind === "shape" && e.shape === "hexagon")).toBe(true);
    expect(plain(json.slides[0]!.elements.find(e => e.id === title)!.text)).toBe("Plan for the launch (draft)");
  });

  // Offline again, an edit, and the tab closed before the connection returns: the edit was kept in this browser
  // (IndexedDB) and reaches the service when the deck is opened again.
  await bo.context.setOffline(true);
  await expect(bo.page.getByTestId("connection-status")).toHaveAttribute("data-status", "offline", { timeout: 20_000 });
  await bo.page.getByTestId("speaker-notes").fill("Kept in this browser");
  await bo.page.waitForTimeout(800);
  await bo.page.close();
  await bo.context.setOffline(false);
  const again = await bo.context.newPage();
  await openDeck(again, deck);
  await expect(again.getByTestId("speaker-notes")).toHaveValue("Kept in this browser");
  await expect(ada.page.getByTestId("speaker-notes")).toHaveValue("Kept in this browser", { timeout: 30_000 });

  expect(ada.errors).toEqual([]);
  await ada.context.close();
  await bo.context.close();
});

test("a Silicon's change through the ops API appears at once with its name", async ({ browser }) => {
  test.setTimeout(180_000);
  const si = await silicon();
  const ada = await signedIn(browser, "carbon");
  const deck = await createDeck(ada.context, "Silicon at work");
  await share(ada.context, deck, si.id, "editor");
  await openDeck(ada.page, deck);
  const slide = await ada.page.evaluate(() => (window as unknown as W).__presentEditor.deck().slides[0]!.id);

  const answer = await si.call("POST", `/v1/decks/${deck}/edits`, {
    summary: "Added the plan",
    ops: [
      { op: "add_element", slide, element: { id: "e_si0001", kind: "text", x: 120, y: 120, w: 900, h: 140, text: { paragraphs: [{ runs: [{ text: "Written by a Silicon" }] }] } } },
      { op: "add_element", slide, element: { id: "e_si0002", kind: "shape", shape: "round-rect", x: 1200, y: 600, w: 400, h: 240, style: { fill: "#12a594" } } },
    ],
  });
  expect(answer.status, JSON.stringify(answer.body)).toBeLessThan(300);

  // Both elements arrive together, each highlighted with the Silicon's name.
  await expect(ada.page.locator('[data-element-id="e_si0001"]')).toContainText("Written by a Silicon");
  await expect(ada.page.locator('[data-element-id="e_si0002"]')).toBeVisible();
  const highlights = ada.page.locator(`[data-testid="change-highlight"][data-author="${si.id}"]`);
  await expect(highlights).toHaveCount(2);
  await expect(highlights.first()).toContainText(/Deck Designer|si:/);
  // The highlight fades away by itself.
  await expect(highlights).toHaveCount(0, { timeout: 10_000 });

  // And the Silicon's edits merge with the Carbon's own: an update_element moves what the Carbon added.
  await ada.page.getByTestId("choose-shape").click();
  await ada.page.getByRole("menuitem", { name: "More shapes", exact: true }).click();
  await ada.page.locator('[data-shape="triangle"]').click();
  await drawArmedShape(ada.page);
  await settled(ada.page);
  const triangle = (await deckJson(ada.context, deck)).slides[0]!.elements.find(e => e.kind === "shape" && e.shape === "triangle")!;
  const moved = await si.call("POST", `/v1/decks/${deck}/edits`, { summary: "Moved the triangle", ops: [{ op: "update_element", slide, element: triangle.id, set: { x: 40, y: 40 } }] });
  expect(moved.status).toBeLessThan(300);
  await eventually(async () => {
    const box = await ada.page.evaluate(id => {
      const el = (window as unknown as W).__presentEditor.deck().slides[0]!.elements.find(e => e.id === id) as unknown as { x: number; y: number };
      return { x: el.x, y: el.y };
    }, triangle.id);
    expect(box).toEqual({ x: 40, y: 40 });
  });
  expect(ada.errors).toEqual([]);
  await ada.context.close();
});
