/**
 * Files: opening a .pptx as a new deck from the decks page (with progress), and downloading a deck in every format
 * from the export menu, checking what arrives is that kind of file. The .pptx comes from the converter's fixtures
 * (renderer/test/fixtures) when there is one, and from this deck's own export otherwise.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createDeck, deckWithSlides, signedIn, type Signed } from "./pages-support";
import { BASE } from "./support";

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
let me: Signed;
let deck = "";
const title = `Export check ${run}`;
const FIXTURES = join(process.cwd(), "..", "renderer", "test", "fixtures");
const OUT = join(process.cwd(), "test-results", `files-${process.env.E2E_LANE ?? "default"}`);

/** What the first bytes of each format are. */
const MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  pptx: bytes => bytes.subarray(0, 2).toString() === "PK",
  odp: bytes => bytes.subarray(0, 2).toString() === "PK" && bytes.includes(Buffer.from("application/vnd.oasis.opendocument.presentation")),
  key: bytes => bytes.subarray(0, 2).toString() === "PK",
  ppt: bytes => bytes.subarray(0, 4).toString("hex") === "d0cf11e0",
  pdf: bytes => bytes.subarray(0, 5).toString() === "%PDF-",
  html: bytes => /^\s*<!doctype html/i.test(bytes.subarray(0, 64).toString()),
  png: bytes => bytes.subarray(0, 2).toString() === "PK" || bytes.subarray(1, 4).toString() === "PNG",
  jpg: bytes => bytes.subarray(0, 2).toString() === "PK" || bytes.subarray(0, 2).toString("hex") === "ffd8",
};

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  me = await signedIn(browser, "carbon");
  deck = await createDeck(me.context, title);
  await deckWithSlides(me.context, deck, [
    { id: "s_exp001", title: "First slide", notes: "Say hello" },
    { id: "s_exp002", title: "Second slide", html: true },
  ]);
});

test.afterAll(async () => {
  await me?.context.close();
});

test("the export menu lists every format and downloads a PDF named after the deck", async () => {
  const { page } = me;
  await page.goto(`/decks/${deck}/history`);
  await page.getByRole("button", { name: "Download" }).first().click();
  const menu = page.getByRole("menu", { name: "Download formats" });
  for (const label of ["PowerPoint (.pptx)", "PowerPoint 97–2003 (.ppt)", "Keynote (.key)", "OpenDocument (.odp)", "PDF (.pdf)", "Web page (.html)", "Images (PNG) (.zip)", "Images (JPG) (.zip)"]) {
    await expect(menu.getByRole("menuitem", { name: new RegExp(label.replace(/[()[\].*+?^$|\\]/g, "\\$&")) })).toBeVisible();
  }
  const [download] = await Promise.all([page.waitForEvent("download"), menu.getByRole("menuitem", { name: /^PDF/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(download.suggestedFilename()).toContain("Export check");
  const path = join(OUT, download.suggestedFilename());
  await download.saveAs(path);
  expect(MAGIC.pdf!(readFileSync(path))).toBe(true);
});

for (const format of ["pptx", "ppt", "odp", "html", "png", "jpg", "key"] as const) {
  test(`export as ${format}`, async () => {
    test.setTimeout(240_000);
    const response = await me.context.request.get(`${BASE}/api/v1/decks/${deck}/export?format=${format}`, { timeout: 200_000 });
    const body = await response.body();
    if (format === "key" && !response.ok()) {
      // Keynote export needs Keynote on the converter's machine; without it the service says so in its own words.
      const error = JSON.parse(body.toString()) as { error: { code: string; message: string; hint?: string } };
      expect(error.error.message.length).toBeGreaterThan(10);
      test.info().annotations.push({ type: "keynote", description: `${error.error.code}: ${error.error.message} ${error.error.hint ?? ""}` });
      return;
    }
    expect(response.status(), body.subarray(0, 300).toString()).toBe(200);
    expect(response.headers()["content-disposition"] ?? "").toMatch(/attachment|filename/);
    expect(MAGIC[format]!(body), `${format} starts with ${body.subarray(0, 8).toString("hex")}`).toBe(true);
    writeFileSync(join(OUT, `export.${format === "png" || format === "jpg" ? `${format}.zip` : format}`), body);
  });
}

test("one slide as an image, and a version's export", async () => {
  const single = await me.context.request.get(`${BASE}/api/v1/decks/${deck}/export?format=png&slide=s_exp001`, { timeout: 120_000 });
  expect(single.status()).toBe(200);
  expect((await single.body()).subarray(1, 4).toString()).toBe("PNG");
  const render = await me.context.request.get(`${BASE}/api/v1/decks/${deck}/slides/s_exp002/render?format=png&width=960`, { timeout: 120_000 });
  expect(render.status()).toBe(200);
  expect((await render.body()).subarray(1, 4).toString()).toBe("PNG");
});

test("opening a .pptx makes a new deck, with progress on the way", async () => {
  test.setTimeout(240_000);
  const { page } = me;
  const fixture = existsSync(FIXTURES) ? readdirSync(FIXTURES).find(name => name.endsWith(".pptx")) : undefined;
  const file = fixture ? join(FIXTURES, fixture) : join(OUT, "export.pptx");
  expect(existsSync(file), `a .pptx to open (${file})`).toBe(true);

  await page.goto("/decks");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open a file" }).click();
  await (await chooser).setFiles(file);
  await expect(page.getByRole("status").filter({ hasText: /Uploading|Building a deck/ }).first()).toBeVisible();
  await page.waitForURL(/\/decks\/[A-Za-z0-9]+$/, { timeout: 200_000 });
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const content = await me.context.request.get(`${BASE}/api/v1/decks/${id}/content?format=json`);
  expect(content.status()).toBe(200);
  const json = (await content.json()) as { slides: Array<{ elements: unknown[] }> };
  expect(json.slides.length).toBeGreaterThan(0);
  if (!fixture) expect(json.slides.length).toBe(2);
});

test("pages report no errors", async () => {
  expect(me.errors).toEqual([]);
});
