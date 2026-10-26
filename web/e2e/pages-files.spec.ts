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

// Each format is independent. A broken native converter must not suppress the
// image-render and import checks that follow it.
test.describe.configure({ mode: "default" });

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
  pdf: bytes => bytes.subarray(0, 5).toString() === "%PDF-",
  txt: bytes => bytes.toString("utf8").includes("First slide") && bytes.toString("utf8").includes("Second slide"),
  svg: bytes => /<svg\s/.test(bytes.toString("utf8")) && /<path\s/.test(bytes.toString("utf8")),
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

test("the export menu has exactly the seven requested formats and downloads a PDF named after the deck", async () => {
  const { page } = me;
  await page.goto(`/decks/${deck}/history`);
  await page.getByRole("button", { name: "Download" }).first().click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Microsoft PowerPoint (.pptx)", "ODP document (.odp)", "PDF document (.pdf)", "Plain text (.txt)",
    "JPEG image (.jpg, current slide)", "PNG image (.png, current slide)", "Scalable Vector Graphics (.svg, current slide)",
  ]);
  await menu.screenshot({ path: join(OUT, "export-menu.png") });
  const [download] = await Promise.all([page.waitForEvent("download"), menu.getByRole("menuitem", { name: /^PDF/ }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(download.suggestedFilename()).toContain("Export check");
  const path = join(OUT, download.suggestedFilename());
  await download.saveAs(path);
  expect(MAGIC.pdf!(readFileSync(path))).toBe(true);
});

test("current-slide exports follow the selected history slide and download individual images", async () => {
  test.setTimeout(240_000);
  const { page } = me;
  await page.goto(`/decks/${deck}/history`);
  await page.getByRole("list", { name: "Slides in this version" }).getByRole("button", { name: "Slide 2", exact: true }).click();
  for (const [format, label] of [["jpg", "JPEG image"], ["png", "PNG image"], ["svg", "Scalable Vector Graphics"]] as const) {
    await page.getByRole("button", { name: "Download" }).first().click();
    const item = page.getByRole("menuitem", { name: `${label} (.${format}, current slide)`, exact: true });
    await expect(item).toHaveAttribute("href", /slide=s_exp002/);
    await expect(item).toHaveAttribute("href", /version=\d+/);
    const [download] = await Promise.all([page.waitForEvent("download"), item.click()]);
    expect(download.suggestedFilename()).toBe(`${title}.${format}`);
    const path = join(OUT, download.suggestedFilename());
    await download.saveAs(path);
    const bytes = readFileSync(path);
    expect(MAGIC[format]!(bytes)).toBe(true);
    expect(bytes.subarray(0, 2).toString()).not.toBe("PK");
  }
  await page.getByRole("button", { name: "Download" }).first().click();
  const text = page.getByRole("menuitem", { name: "Plain text (.txt)", exact: true });
  await expect(text).not.toHaveAttribute("href", /slide=/);
  const [download] = await Promise.all([page.waitForEvent("download"), text.click()]);
  const path = join(OUT, download.suggestedFilename());
  await download.saveAs(path);
  expect(MAGIC.txt!(readFileSync(path))).toBe(true);
});

for (const format of ["pptx", "odp", "pdf", "txt", "png", "jpg"] as const) {
  test(`export as ${format}`, async () => {
    test.setTimeout(240_000);
    const response = await me.context.request.get(`${BASE}/api/v1/decks/${deck}/export?format=${format}`, { timeout: 200_000 });
    const body = await response.body();
    expect(response.status(), body.subarray(0, 300).toString()).toBe(200);
    expect(response.headers()["content-disposition"] ?? "").toMatch(/attachment|filename/);
    expect(MAGIC[format]!(body), `${format} starts with ${body.subarray(0, 8).toString("hex")}`).toBe(true);
    writeFileSync(join(OUT, `export.${format === "png" || format === "jpg" ? `${format}.zip` : format}`), body);
  });
}

test("ppt, key and html are not download formats", async () => {
  for (const format of ["ppt", "key", "html"]) {
    const response = await me.context.request.get(`${BASE}/api/v1/decks/${deck}/export?format=${format}`);
    expect(response.status(), format).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("invalid_format");
  }
});

test("one slide as a picture: the export answers the image itself, and a slide render", async () => {
  const single = await me.context.request.get(`${BASE}/api/v1/decks/${deck}/export?format=png&slide=s_exp001`, { timeout: 120_000 });
  expect(single.status()).toBe(200);
  expect(single.headers()["content-disposition"] ?? "").toMatch(/\.png/);
  expect((await single.body()).subarray(1, 4).toString()).toBe("PNG");
  const render = await me.context.request.get(`${BASE}/api/v1/decks/${deck}/slides/s_exp002/render?format=jpg&width=960`, { timeout: 120_000 });
  expect(render.status()).toBe(200);
  expect((await render.body()).subarray(0, 2).toString("hex")).toBe("ffd8");
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
  await page.waitForURL(/\/decks\/[A-Za-z0-9]+(\?.*)?$/, { timeout: 200_000 });
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
