import { expect, test, type Locator } from "@playwright/test";
import { call, createDeck, edit, signedIn } from "./pages-support";
import { openDeck } from "./editor-support";

const htmlElement = {
  id: "e_preview", kind: "html", x: 0, y: 0, w: 1920, h: 1080,
  html: '<main><h1 id="label">Waiting</h1><button id="play">Play</button><pre id="boundary"></pre></main>',
  css: 'html,body,main{box-sizing:border-box;height:100%;margin:0}main{padding:100px;background:#10243c;color:#d9ff72;font:64px system-ui}h1{font:inherit}button{font:40px system-ui}pre{font:18px monospace;white-space:pre-wrap}',
  js: `document.getElementById('label').textContent='HTML preview is running';
const boundary={};for(const [key,read] of Object.entries({cookie:()=>document.cookie,storage:()=>localStorage.length,parent:()=>parent.document.title})){try{boundary[key]=read()}catch(e){boundary[key]=e.name}}
document.getElementById('boundary').textContent=JSON.stringify(boundary);
document.getElementById('play').onclick=()=>document.getElementById('label').textContent='Played';`,
};

async function rendered(preview: Locator, text = "HTML preview is running") {
  const iframe = preview.locator("iframe.sp-html");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("src", "/sandbox/html");
  await expect(iframe).toBeVisible();
  await expect(preview.frameLocator("iframe.sp-html").locator("#label")).toHaveText(text);
  expect(await iframe.evaluate(frame => ({
    inert: !!frame.closest("[inert]"),
    parentCanRead: !!(frame as HTMLIFrameElement).contentDocument,
  }))).toEqual({ inert: true, parentCanRead: false });
  expect(JSON.parse((await preview.frameLocator("iframe.sp-html").locator("#boundary").textContent())!))
    .toEqual({ cookie: "SecurityError", storage: "SecurityError", parent: "SecurityError" });
}

test("HTML previews render in the strip, grid, home and history without escaping the sandbox", async ({ browser }) => {
  const me = await signedIn(browser, "carbon");
  try {
    const title = `HTML preview ${Date.now()}`;
    const deck = await createDeck(me.context, title);
    const slide = (await call<{ slides: Array<{ id: string }> }>(me.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
    await edit(me.context, deck, [{ op: "add_element", slide, element: htmlElement }]);
    await openDeck(me.page, deck);
    const thumbnail = me.page.getByTestId("slide-thumb").first();
    await rendered(thumbnail);
    await me.page.screenshot({ path: test.info().outputPath("html-editor-preview.png") });

    // The preview follows the actual document, including code changes arriving through the live connection.
    await edit(me.context, deck, [{ op: "update_element", slide, element: htmlElement.id, set: { js: htmlElement.js.replace("HTML preview is running", "Updated HTML preview") } }]);
    await rendered(thumbnail, "Updated HTML preview");
    await me.page.getByRole("button", { name: "Grid view", exact: true }).click();
    await rendered(me.page.getByTestId("slide-overview"), "Updated HTML preview");
    await me.page.screenshot({ path: test.info().outputPath("html-grid-preview.png") });

    await me.page.goto("/decks");
    const card = me.page.getByRole("img", { name: `First slide of ${title}`, exact: true });
    await rendered(card, "Updated HTML preview");
    // Clicking the HTML area opens the deck instead of clicking the embedded Play button.
    await card.click();
    await expect(me.page).toHaveURL(new RegExp(`/decks/${deck}(\\?|$)`));
    await me.page.getByRole("link", { name: "Version history", exact: true }).click();
    await rendered(me.page.getByRole("button", { name: "Slide 1", exact: true }), "Updated HTML preview");
  } finally {
    await me.context.close();
  }
});

test("offscreen HTML thumbnails stop and reload as they return, while clicks still select slides", async ({ browser }) => {
  const me = await signedIn(browser, "carbon");
  try {
    const deck = await createDeck(me.context, `Long HTML preview ${Date.now()}`);
    const first = (await call<{ slides: Array<{ id: string }> }>(me.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
    const ops: unknown[] = [{ op: "add_element", slide: first, element: htmlElement }];
    let after = first;
    for (let i = 1; i <= 15; i++) {
      const id = `s_preview${i}`;
      ops.push({ op: "add_slide", after, slide: { id, layout: "blank", elements: i === 15 ? [{ ...htmlElement, id: "e_lastpreview" }] : [] } });
      after = id;
    }
    await edit(me.context, deck, ops);
    await openDeck(me.page, deck);
    const firstThumb = me.page.getByTestId("slide-thumb").first();
    const lastThumb = me.page.getByTestId("slide-thumb").last();
    await rendered(firstThumb);
    await expect(lastThumb.locator("iframe")).toHaveCount(0);
    await lastThumb.scrollIntoViewIfNeeded();
    await rendered(lastThumb);
    await expect(firstThumb.locator("iframe")).toHaveCount(0);
    await lastThumb.click();
    await expect(lastThumb).toHaveAttribute("aria-current", "true");
    await expect(lastThumb.frameLocator("iframe").locator("#label")).toHaveText("HTML preview is running");
    await firstThumb.scrollIntoViewIfNeeded();
    await rendered(firstThumb);
    await expect(lastThumb.locator("iframe")).toHaveCount(0);
  } finally {
    await me.context.close();
  }
});
