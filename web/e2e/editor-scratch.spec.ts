import { test } from "@playwright/test";
import { createDeck, signedIn } from "./pages-support";
import { openDeck } from "./editor-support";

test("scratch: idb", async ({ browser }) => {
  const a = await signedIn(browser, "carbon");
  const id = await createDeck(a.context, "IDB deck");
  await openDeck(a.page, id);
  await a.context.setOffline(true);
  await a.page.waitForTimeout(2000);
  await a.page.getByTestId("speaker-notes").fill("Kept in this browser");
  await a.page.waitForTimeout(1000);
  const dump = await a.page.evaluate(async (deck) => {
    const ed = (window as any).__presentEditor;
    const dbs = await indexedDB.databases();
    return { notes: ed.jsonNow().slides[0].notes, dbs: dbs.map(d => d.name), status: ed.status.get() };
  }, id);
  console.log(JSON.stringify(dump));
  await a.page.close();
  await a.context.setOffline(false);
  const p = await a.context.newPage();
  p.on("console", m => console.log("console", m.text().slice(0, 200)));
  await p.goto(`/decks/${id}`);
  await p.waitForTimeout(4000);
  const dump2 = await p.evaluate(() => { const ed = (window as any).__presentEditor; return { notes: ed.jsonNow().slides[0].notes, status: ed.status.get() }; });
  console.log(JSON.stringify(dump2));
});
