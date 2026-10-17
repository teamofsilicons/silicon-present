import { test } from "@playwright/test";
import { call, createDeck, edit, signedIn } from "./pages-support";
import { openDeck } from "./editor-support";

test("scratch: click html", async ({ browser }) => {
  const a = await signedIn(browser, "carbon");
  const deck = await createDeck(a.context, "Click html");
  const first = (await call<{ slides: Array<{ id: string }> }>(a.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
  await edit(a.context, deck, [
    { op: "add_slide", after: first, slide: { id: "s_cmnt01", layout: "blank", elements: [
      { id: "e_cmhtml", kind: "html", x: 1100, y: 300, w: 700, h: 400, html: '<div id="live">running</div>', css: "", js: "" } ] } },
    { op: "delete_slide", slide: first },
  ]);
  await openDeck(a.page, deck);
  const box = (await a.page.getByTestId("slide-canvas").boundingBox())!;
  const x = box.x + (1450 / 1920) * box.width, y = box.y + (500 / 1080) * box.height;
  const el = await a.page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y)!; return e.tagName + " " + e.className + " " + (e.getAttribute("data-testid") ?? ""); }, [x, y]);
  console.log("at point:", el);
  await a.page.mouse.click(x, y);
  await a.page.waitForTimeout(300);
  console.log(await a.page.evaluate(() => JSON.stringify((window as any).__presentEditor.ui.get().selection)));
  await a.page.keyboard.press("Meta+Alt+m");
  await a.page.waitForTimeout(300);
  console.log(await a.page.evaluate(() => JSON.stringify((window as any).__presentEditor.ui.get().composer)));
});
