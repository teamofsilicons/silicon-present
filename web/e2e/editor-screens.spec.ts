/**
 * PNGs of the editor for looking at by eye (`pnpm exec playwright test --project=screens e2e/editor-screens.spec.ts`):
 * an editor with a full deck, text being edited, an HTML element's code, find and replace, comment mode with threads,
 * a commenter's view, a signed-out visitor of a public deck, and the phone's read-and-comment view; at 1440 x 900 and
 * 390 x 844, into test-results/editor-screens/. No page may scroll sideways.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { call, createDeck, edit, signedIn, type Signed } from "./pages-support";
import { BASE, runAccounts } from "./support";
import { openDeck, setPublic, share, silicon } from "./editor-support";

test.describe.configure({ mode: "serial" });

const OUT = "test-results/editor-screens";
let ada: Signed;
let bo: Signed;
let deck = "";

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(900);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways, `${name} scrolls sideways by ${sideways}px`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function upload(context: BrowserContext, deckId: string, file: string, type: string): Promise<string> {
  const response = await context.request.post(`${BASE}/api/v1/decks/${deckId}/assets`, {
    headers: { Origin: BASE, "Sec-Fetch-Site": "same-origin", "Content-Type": type, "X-Filename": file },
    data: readFileSync(resolve(__dirname, "../../renderer/test/fixtures", file)),
  });
  return ((await response.json()) as { id: string }).id;
}

const rt = (text: string, para: Record<string, unknown> = {}, run: Record<string, unknown> = {}) => ({ paragraphs: text.split("\n").map(line => ({ ...para, runs: line ? [{ ...run, text: line }] : [] })) });

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  ada = await signedIn(browser, "carbon", { reducedMotion: "reduce" });
  bo = await signedIn(browser, "friend", { reducedMotion: "reduce" });
  deck = await createDeck(ada.context, "Q4 review");
  const first = (await call<{ slides: Array<{ id: string; elements: Array<{ id: string }> }> }>(ada.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!;
  const picture = await upload(ada.context, deck, "picture.png", "image/png");
  await edit(ada.context, deck, [
    { op: "update_element", slide: first.id, element: first.elements[0]!.id, set: { text: rt("Q4 review", { heading: 1 }) } },
    { op: "update_element", slide: first.id, element: first.elements[1]!.id, set: { text: rt("Where we are, and what comes next") } },
    { op: "update_slide", slide: first.id, set: { section: "Opening", notes: "Open with the headline number." } },
    {
      op: "add_slide",
      after: first.id,
      slide: {
        id: "s_scrn02",
        layout: "title-body",
        notes: "Pause on the chart.",
        transition: { type: "fade", duration: 400 },
        elements: [
          { id: "e_s2titl", kind: "text", x: 140, y: 80, w: 1640, h: 170, style: { verticalAlign: "bottom" }, text: rt("Revenue grew in every region", { heading: 2 }) },
          { id: "e_s2body", kind: "text", x: 140, y: 300, w: 760, h: 420, text: rt("North led with 40% growth\nSouth doubled its pipeline\nWest held steady", { list: "bullet" }), animation: { effect: "fade", trigger: "click", order: 1, duration: 400, delay: 0 } },
          { id: "e_s2chrt", kind: "chart", x: 980, y: 290, w: 800, h: 480, chart: { type: "column", title: "Revenue by quarter", labels: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "2025", values: [8, 9, 11, 12] }, { name: "2026", values: [10, 13, 15, 19] }], legend: true } },
          { id: "e_s2tabl", kind: "table", x: 140, y: 780, w: 760, h: 220, rows: 3, cols: 3, headerRow: true, cells: [[{ text: rt("Region") }, { text: rt("Q3") }, { text: rt("Q4") }], [{ text: rt("North") }, { text: rt("12") }, { text: rt("17") }], [{ text: rt("South") }, { text: rt("9") }, { text: rt("14") }]] },
          { id: "e_s2imag", kind: "image", x: 980, y: 800, w: 260, h: 200, src: `asset:${picture}`, alt: "A picture", fit: "cover", style: { radius: 16 } },
          { id: "e_s2shap", kind: "shape", shape: "round-rect", x: 1290, y: 800, w: 490, h: 200, style: { fill: "#2f5bea" }, text: rt("Next: hiring plan", { align: "center" }) },
        ],
      },
    },
    {
      op: "add_slide",
      after: "s_scrn02",
      slide: {
        id: "s_scrn03",
        layout: "blank",
        skipped: true,
        elements: [
          { id: "e_s3html", kind: "html", x: 160, y: 140, w: 1600, h: 800, html: '<div class="wrap"><h1>Live dashboard</h1><p id="t"></p></div>', css: ".wrap{height:100%;display:grid;place-content:center;text-align:center;font-family:system-ui;background:linear-gradient(135deg,#eef3ff,#fff);border-radius:24px}h1{font-size:96px;margin:0}p{font-size:40px;color:#555}", js: "const t=document.getElementById('t');setInterval(()=>t.textContent=new Date().toLocaleTimeString(),500)" },
        ],
      },
    },
  ]);
  await share(ada.context, deck, runAccounts().friend.id, "commenter");
  await call(bo.context, "POST", `/v1/decks/${deck}/threads`, { anchor: { kind: "area", slide: "s_scrn02", x: 1000, y: 320, w: 500, h: 300, element: "e_s2chrt", ex: 0.025, ey: 0.06, ew: 0.625, eh: 0.625 }, body: "Can the 2025 bars be lighter?" });
  await call(bo.context, "POST", `/v1/decks/${deck}/threads`, { anchor: { kind: "point", slide: "s_scrn02", x: 600, y: 420 }, body: "Add the West numbers here" });
  await call(bo.context, "POST", `/v1/decks/${deck}/threads`, { anchor: { kind: "deck" }, body: "Looks good overall. Brand colours on the last slide?" });
});

test.afterAll(async () => {
  await ada?.context.close();
  await bo?.context.close();
});

test("the editor at 1440", async () => {
  const page = ada.page;
  await openDeck(page, deck, "?slide=s_scrn02");
  await shoot(page, "editor-1440");
  await page.mouse.click(...(await centerOf(page, "e_s2chrt")));
  await shoot(page, "editor-chart-selected-1440");
  await page.mouse.dblclick(...(await centerOf(page, "e_s2body")));
  await page.locator('[data-testid="text-editor"] .ql-editor').waitFor();
  await shoot(page, "editor-text-editing-1440");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByTestId("slide-thumb").nth(2).click();
  await page.mouse.click(...(await centerOf(page, "e_s3html")));
  await page.getByTestId("open-code").click();
  await shoot(page, "editor-html-code-1440");
  await page.getByRole("button", { name: "Close the code" }).click();
  await page.getByTestId("slide-thumb").nth(1).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
  await page.getByTestId("find-input").fill("region");
  await shoot(page, "editor-find-1440");
  await page.getByRole("button", { name: "Close find and replace" }).click();
  await page.getByTestId("comment-mode").click();
  await page.getByTestId("comment-pin").first().click();
  await shoot(page, "editor-comments-1440");
  await page.getByTestId("tab-theme").click();
  await shoot(page, "editor-theme-1440");
  await page.getByTestId("tab-animate").click();
  await shoot(page, "editor-animate-1440");
});

test("others in the deck: a Carbon's cursor and a Silicon's change", async () => {
  const si = await silicon();
  await share(ada.context, deck, si.id, "editor");
  await ada.page.setViewportSize({ width: 1440, height: 900 });
  await openDeck(ada.page, deck, "?slide=s_scrn02");
  await openDeck(bo.page, deck, "?slide=s_scrn02");
  const box = (await bo.page.getByTestId("slide-canvas").boundingBox())!;
  await bo.page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.3, { steps: 4 });
  await expect(ada.page.getByTestId("remote-cursor")).toBeVisible();
  await si.call("POST", `/v1/decks/${deck}/edits`, {
    summary: "Made the takeaway stand out",
    ops: [{ op: "update_element", slide: "s_scrn02", element: "e_s2shap", set: { style: { fill: "#12a594" } } }, { op: "update_element", slide: "s_scrn02", element: "e_s2titl", set: { text: rt("Revenue grew in every region, led by the North", { heading: 2 }) } }],
  });
  await expect(ada.page.getByTestId("change-highlight").first()).toBeVisible();
  await ada.page.screenshot({ path: `${OUT}/editor-others-1440.png` });
});

test("a commenter and a signed-out visitor at 1440 and 390", async ({ browser }) => {
  await openDeck(bo.page, deck, "?slide=s_scrn02");
  await shoot(bo.page, "commenter-1440");
  const p = await centerOf(bo.page, "e_s2shap");
  await bo.page.mouse.click(p[0], p[1]);
  await shoot(bo.page, "commenter-composer-1440");
  await bo.page.keyboard.press("Escape");
  await bo.page.setViewportSize({ width: 390, height: 844 });
  await bo.page.reload();
  await bo.page.getByTestId("slide-canvas").waitFor();
  await shoot(bo.page, "commenter-390");
  await bo.page.getByTestId("toggle-comments").click();
  await shoot(bo.page, "commenter-comments-390");
  await bo.page.setViewportSize({ width: 1440, height: 900 });

  await setPublic(ada.context, deck, "view");
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await anon.newPage();
  await page.goto(`/decks/${deck}?slide=s_scrn02`);
  await page.getByTestId("slide-canvas").waitFor();
  await shoot(page, "public-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId("slide-canvas").waitFor();
  await shoot(page, "public-390");
  await anon.close();

  await ada.page.setViewportSize({ width: 390, height: 844 });
  await ada.page.goto(`/decks/${deck}?slide=s_scrn02`);
  await ada.page.getByTestId("slide-canvas").waitFor();
  await shoot(ada.page, "editor-390");
});

async function centerOf(page: Page, id: string): Promise<[number, number]> {
  const box = (await page.locator(`[data-element-id="${id}"]`).first().boundingBox())!;
  return [box.x + box.width / 2, box.y + box.height / 2];
}
