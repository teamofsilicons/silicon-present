/**
 * Editing the inside of an HTML element (components/editor/html-inside.tsx): double-click it, then type into a piece of
 * its text, drag a part to move it and give a part another colour. Each change lands in the element's own `html` (not
 * in what its JS made), live for another editor, undoable, kept after a reload, and the element still runs its JS in
 * present mode. The edit frame stays sandboxed and runs none of the element's code.
 */
import { expect, test, type Page } from "@playwright/test";
import { call, createDeck, edit, signedIn } from "./pages-support";
import { runAccounts } from "./support";
import { deckJson, openDeck, settled, share } from "./editor-support";

const ID = "e_inside";
const HTML = `<div class="card">
  <h1 id="title">Quarterly <b>results</b></h1>
  <p id="note">Draft</p>
  <div id="pic" class="pic"></div>
  <img id="bad" src="data:," alt="" onerror="this.setAttribute('data-ran', '1')">
  <p id="js">waiting</p>
</div>`;
const CSS = `.card{padding:40px;font-family:sans-serif} h1{font-size:72px;margin:0} #note{font-size:40px} .pic{width:160px;height:120px;background:#1F5FB8} #js{font:28px monospace}`;
const JS = `document.getElementById("js").textContent = "JS ran";
const made = document.createElement("p"); made.id = "generated"; made.textContent = "made by JS"; document.body.appendChild(made);`;

async function htmlOf(page: Page, deck: string): Promise<string> {
  const json = await deckJson(page.context(), deck);
  const element = json.slides[0]!.elements.find(e => e.id === ID) as { html?: string } | undefined;
  return element?.html ?? "";
}

test("a Carbon edits the text, places and colours inside an HTML element, in its source", async ({ browser }) => {
  test.setTimeout(240_000);
  const ada = await signedIn(browser, "carbon");
  const bo = await signedIn(browser, "friend");
  const deck = await createDeck(ada.context, "Inside an HTML element");
  await share(ada.context, deck, runAccounts().friend.id, "editor");
  const slide = (await call<{ slides: Array<{ id: string }> }>(ada.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
  await edit(ada.context, deck, [{ op: "add_element", slide, element: { id: ID, kind: "html", x: 100, y: 100, w: 1700, h: 880, html: HTML, css: CSS, js: JS } }]);
  await openDeck(ada.page, deck);
  await openDeck(bo.page, deck);

  // It runs on the canvas as always.
  const live = (page: Page) => page.frameLocator(`[data-element-id="${ID}"] iframe`);
  await expect(live(ada.page).locator("#js")).toHaveText("JS ran", { timeout: 20_000 });

  // Double-click: the edit frame shows the source, with the element's JS (and its inline handlers) not running.
  const box = (await ada.page.locator(`[data-element-id="${ID}"]`).boundingBox())!;
  await ada.page.mouse.dblclick(box.x + box.width * 0.9, box.y + box.height * 0.9);
  const frameNode = ada.page.getByTestId("html-inside-frame");
  await expect(frameNode).toHaveAttribute("sandbox", "allow-scripts");
  const inside = ada.page.frameLocator('[data-testid="html-inside-frame"]');
  await expect(inside.locator("#js")).toHaveText("waiting", { timeout: 20_000 });
  await expect(inside.locator("#generated")).toHaveCount(0);
  await expect(inside.locator("#bad")).not.toHaveAttribute("data-ran", "1");
  await expect(ada.page.getByTestId("html-inside-tools")).toBeVisible();

  // Type into a piece of text.
  await inside.locator("#note").dblclick();
  await expect(inside.locator("#note")).toHaveAttribute("contenteditable", /plaintext-only|true/);
  await ada.page.keyboard.press("ControlOrMeta+a");
  await ada.page.keyboard.type("Final numbers");
  await ada.page.keyboard.press("Enter");
  await expect.poll(() => htmlOf(ada.page, deck), { timeout: 20_000 }).toContain('<p id="note">Final numbers</p>');
  // Another editor sees it at once.
  await expect(live(bo.page).locator("#note")).toHaveText("Final numbers", { timeout: 20_000 });

  // Drag a part: it moves by a translate written on that part.
  const pic = (await inside.locator("#pic").boundingBox())!;
  await ada.page.mouse.move(pic.x + pic.width / 2, pic.y + pic.height / 2);
  await ada.page.mouse.down();
  await ada.page.mouse.move(pic.x + pic.width / 2 + 60, pic.y + pic.height / 2 + 30, { steps: 8 });
  await ada.page.mouse.up();
  await expect.poll(() => htmlOf(ada.page, deck), { timeout: 20_000 }).toMatch(/<div id="pic" class="pic" style="translate: \d+(\.\d)?px \d+(\.\d)?px"><\/div>/);

  // Select the heading and give it another text colour from the toolbar.
  await inside.locator("#title").click({ position: { x: 20, y: 20 } });
  const tools = ada.page.getByTestId("html-inside-tools");
  await expect(tools.getByTestId("html-inside-part")).toHaveText("<h1>");
  await tools.getByRole("button", { name: "Text colour" }).click();
  await ada.page.getByLabel("Text colour: hex colour").fill("#C0392B");
  await ada.page.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => htmlOf(ada.page, deck), { timeout: 20_000 }).toContain('<h1 id="title" style="color: #C0392B">Quarterly <b>results</b></h1>');
  await expect(inside.locator("#title")).toHaveCSS("color", "rgb(192, 57, 43)");

  // The editor's undo takes it back, redo brings it again.
  await ada.page.getByTestId("undo").click();
  await expect.poll(() => htmlOf(ada.page, deck), { timeout: 20_000 }).toContain('<h1 id="title">Quarterly');
  await ada.page.getByTestId("redo").click();
  await expect.poll(() => htmlOf(ada.page, deck), { timeout: 20_000 }).toContain('style="color: #C0392B"');

  // Done: the element runs again. What its JS made never reached the source, and the rest of it is as written.
  await ada.page.getByTestId("html-inside-done").click();
  await expect(frameNode).toHaveCount(0);
  await settled(ada.page);
  const html = await htmlOf(ada.page, deck);
  expect(html).not.toContain("made by JS");
  expect(html).not.toContain("data-sp-part");
  expect(html).toContain(`<img id="bad" src="data:," alt="" onerror="this.setAttribute('data-ran', '1')">`);

  // After a reload everything is still there, and running.
  await openDeck(ada.page, deck);
  await expect(live(ada.page).locator("#js")).toHaveText("JS ran", { timeout: 20_000 });
  await expect(live(ada.page).locator("#note")).toHaveText("Final numbers");
  await expect(live(ada.page).locator("#title")).toHaveCSS("color", "rgb(192, 57, 43)");
  await expect(live(ada.page).locator("#pic")).toHaveCSS("translate", /^\d+(\.\d)?px \d+(\.\d)?px$/);

  // Present mode shows the changes and runs the element's JS.
  await ada.page.goto(`/decks/${deck}/present`);
  const presented = ada.page.frameLocator(`.sp-el[data-sp-id="${ID}"] iframe`).last();
  await expect(presented.locator("#js")).toHaveText("JS ran", { timeout: 20_000 });
  await expect(presented.locator("#generated")).toHaveText("made by JS");
  await expect(presented.locator("#note")).toHaveText("Final numbers");
  await expect(presented.locator("#title")).toHaveCSS("color", "rgb(192, 57, 43)");

  // The only complaints are policies refusing the element's inline handler where it must not run (the edit frame; a
  // srcdoc frame for the moment before it moves to the sandbox page).
  expect(ada.errors.filter(e => !e.includes("Content Security Policy"))).toEqual([]);
  await call(ada.context, "DELETE", `/v1/decks/${deck}`);
  await ada.context.close();
  await bo.context.close();
});

test("a whole page opened as one HTML element is edited in place, its source kept as written around each change", async ({ browser }) => {
  test.setTimeout(180_000);
  const ada = await signedIn(browser, "carbon");
  const deck = await createDeck(ada.context, "A page inside");
  const slide = (await call<{ slides: Array<{ id: string }> }>(ada.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
  const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Launch</title>
<style>body { margin: 0; font: 32px/1.4 Georgia, serif } .hero h2 { color: navy; font-size: 80px }</style>
</head>
<body class='page'>
<section class="hero"><h2>Welcome</h2><p id=lead>Hello <em>there</em>, friend</p></section>
<ul><li>One<li>Two</ul>
</body>
</html>`;
  await edit(ada.context, deck, [{ op: "add_element", slide, element: { id: ID, kind: "html", x: 0, y: 0, w: 1920, h: 1080, html: page, css: "", js: "" } }]);
  await openDeck(ada.page, deck);
  const box = (await ada.page.locator(`[data-element-id="${ID}"]`).boundingBox())!;
  await ada.page.mouse.dblclick(box.x + box.width * 0.8, box.y + box.height * 0.8);
  const inside = ada.page.frameLocator('[data-testid="html-inside-frame"]');
  await expect(inside.locator("h2")).toHaveText("Welcome", { timeout: 20_000 });

  // Text with markup inside: each run keeps its markup.
  await inside.locator("#lead em").dblclick();
  await ada.page.keyboard.press("ControlOrMeta+a");
  await ada.page.keyboard.type("you");
  await ada.page.keyboard.press("Enter");
  await expect.poll(() => htmlOf(ada.page, deck), { timeout: 20_000 }).toContain("<p id=lead>Hello <em>you</em>, friend</p>");

  // A list item whose end tag is left out, then the page's own body: styles go on their start tags.
  await inside.locator("li").nth(1).click();
  await expect(ada.page.getByTestId("html-inside-part")).toHaveText("<li>");
  await ada.page.getByTestId("html-inside-tools").getByRole("button", { name: "Bold" }).click();
  await expect.poll(() => htmlOf(ada.page, deck), { timeout: 20_000 }).toContain(`<li style="font-weight: bold">Two</ul>`);
  await ada.page.keyboard.press("Escape");
  await expect(ada.page.getByTestId("html-inside-frame")).toHaveCount(0);

  // Everything around the changes is exactly as written.
  const html = await htmlOf(ada.page, deck);
  expect(html.replace("<em>you</em>", "<em>there</em>").replace(` style="font-weight: bold"`, "")).toBe(page);
  await call(ada.context, "DELETE", `/v1/decks/${deck}`);
  await ada.context.close();
});
