/**
 * Custom themes: a Carbon saves a deck's theme to their themes and uses it in another deck from the Theme panel; an
 * editor of the shared deck adds the same theme to their own themes; a commenter gets no Theme panel at all.
 */
import { expect, test } from "@playwright/test";
import { call, createDeck, eventually, signedIn } from "./pages-support";
import { runAccounts } from "./support";
import { deckJson, openDeck, settled, share } from "./editor-support";

// The accounts persist between runs, and a look already in your themes offers no save: each run gets its own muted colour.
const MUTED = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
const BRAND = {
  name: "Ivory",
  fonts: { heading: "Fraunces", body: "Inter" },
  colors: { background: "#101820", text: "#f2f2f2", accent: "#fee715", accent2: "#e5484d", accent3: "#12a594", muted: MUTED },
  customFonts: [],
};

test("save a deck's theme, use it in another deck, and add a shared deck's theme as an editor", async ({ browser }) => {
  test.setTimeout(180_000);
  const ada = await signedIn(browser, "carbon");
  const bo = await signedIn(browser, "friend");
  const name = `Brand ${Date.now().toString(36)}`;
  const first = await createDeck(ada.context, "Brand launch");
  await call(ada.context, "POST", `/v1/decks/${first}/edits`, { ops: [{ op: "update_deck", set: { theme: BRAND } }] });

  // The owner saves the deck's theme from the Theme panel.
  await openDeck(ada.page, first);
  await ada.page.getByTestId("tab-theme").click();
  await ada.page.getByTestId("theme-save").filter({ hasText: "Save to my themes" }).click();
  await ada.page.getByTestId("theme-name").fill(name);
  await ada.page.getByTestId("theme-save-confirm").click();
  await expect(ada.page.getByTestId("saved-theme-option").filter({ hasText: name })).toBeVisible();
  await expect(ada.page.getByTestId("theme-save")).toHaveCount(0);

  // And uses it in another deck.
  const second = await createDeck(ada.context, "Follow-up");
  await openDeck(ada.page, second);
  await ada.page.getByTestId("tab-theme").click();
  await ada.page.getByTestId("saved-theme-option").filter({ hasText: name }).click();
  await settled(ada.page);
  await eventually(async () => {
    const theme = (await deckJson(ada.context, second)).theme as typeof BRAND;
    expect(theme.name).toBe(name);
    expect(theme.colors.accent).toBe("#fee715");
  });

  // An editor of the shared deck adds the theme to their own themes; it isn't Ada's copy.
  await share(ada.context, first, runAccounts().friend.id, "editor");
  await openDeck(bo.page, first);
  await bo.page.getByTestId("tab-theme").click();
  await bo.page.getByTestId("theme-save").filter({ hasText: "Add to my themes" }).click();
  await bo.page.getByTestId("theme-name").fill(`${name} (Bo)`);
  await bo.page.getByTestId("theme-save-confirm").click();
  await expect(bo.page.getByTestId("saved-theme-option").filter({ hasText: `${name} (Bo)` })).toBeVisible();
  const { body: mine } = await call<{ themes: Array<{ name: string }> }>(bo.context, "GET", "/v1/themes");
  expect(mine.themes.map(t => t.name)).toContain(`${name} (Bo)`);
  const { body: adas } = await call<{ themes: Array<{ name: string }> }>(ada.context, "GET", "/v1/themes");
  expect(adas.themes.map(t => t.name)).not.toContain(`${name} (Bo)`);

  // A commenter has no Theme panel, and the service refuses them too.
  const third = await createDeck(ada.context, "Comments only");
  await call(ada.context, "POST", `/v1/decks/${third}/edits`, { ops: [{ op: "update_deck", set: { theme: BRAND } }] });
  await share(ada.context, third, runAccounts().friend.id, "commenter");
  await openDeck(bo.page, third);
  await expect(bo.page.getByTestId("tab-theme")).toHaveCount(0);
  const refused = await call<{ error: { code: string } }>(bo.context, "POST", "/v1/themes", { deck: third, name: `${name} (no)` }, [403]);
  expect(refused.body.error.code).toBe("edit_not_allowed");
  expect(ada.errors).toEqual([]);
  expect(bo.errors).toEqual([]);
});
