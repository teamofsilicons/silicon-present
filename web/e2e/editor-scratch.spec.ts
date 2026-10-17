import { test } from "@playwright/test";
import { createDeck, signedIn } from "./pages-support";
const SP = "/private/tmp/claude-501/-Users-codanium-Documents-silicon/f24a4c2d-da87-42fd-81c8-546335de60a8/scratchpad";

test("scratch: open the editor", async ({ browser }) => {
  const a = await signedIn(browser, "carbon");
  const page = a.page;
  const id = await createDeck(a.context, "Scratch deck");
  await page.goto(`/decks/${id}`);
  await page.getByTestId("slide-canvas").waitFor();
  await page.waitForTimeout(1500);
  await page.getByTestId("insert-text").click();
  await page.locator(".ql-editor").waitFor();
  await page.keyboard.type("Hello from the editor");
  await page.screenshot({ path: `${SP}/e2.png` });
  await page.keyboard.press("Escape");
  await page.getByTestId("insert-html").click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SP}/e3.png` });
  // drag the html element towards the left edge, slowly, and capture guides
  const box = (await page.locator('[data-kind="html"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 - 50, { steps: 8 });
  await page.screenshot({ path: `${SP}/e4.png` });
  await page.mouse.up();
  console.log(a.errors);
});
