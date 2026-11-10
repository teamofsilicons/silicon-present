import { expect, test } from "@playwright/test";
import { call, createDeck, signedIn } from "./pages-support";

test("an open library refreshes through its Ting session after an API mutation", async ({ browser }) => {
  const me = await signedIn(browser, "carbon");
  try {
    const connected = me.page.waitForResponse(r => r.url().includes("/api/v1/library/events") && r.status() === 200);
    await me.page.goto("/decks");
    await expect(me.page.getByRole("heading", { name: "Decks", exact: true })).toBeVisible();
    // Headers arrive only after the backend has registered and bound this receiver.
    await connected;
    const title = `Session library ${Date.now()}`;
    const id = await createDeck(me.context, title);
    await expect(me.page.getByRole("link", { name: title, exact: true })).toBeVisible({ timeout: 10_000 });
    await call(me.context, "PATCH", `/v1/decks/${id}`, { title: `${title} renamed` });
    await expect(me.page.getByRole("link", { name: `${title} renamed`, exact: true })).toBeVisible({ timeout: 10_000 });
    await call(me.context, "DELETE", `/v1/decks/${id}`);
    await expect(me.page.getByRole("link", { name: `${title} renamed`, exact: true })).toHaveCount(0, { timeout: 10_000 });
  } finally { await me.context.close(); }
});
