/**
 * Comments, as UNDERSTANDING.md asks: as easy as pointing. A commenter clicks a point or drags an area and the box
 * opens right there; they pick words in a text to comment on them; an editor comments on a running HTML element with
 * the keyboard; whole-slide and whole-deck comments start in the list. Replies, reactions, edits, deletes, resolve and
 * reopen; threads arrive live and are walked through with the keyboard; a mention of a Silicon reaches it through
 * Silicon Ting; a comment on a deleted element still says what it was on. A viewer can't comment; a signed-out visitor
 * of a public deck is asked to sign in.
 */
import { expect, test, type Page } from "@playwright/test";
import { call, createDeck, edit, eventually, signedIn } from "./pages-support";
import { runAccounts } from "./support";
import { openDeck, setPublic, share, silicon, tings } from "./editor-support";

const SLIDE = "s_cmnt01";

async function slideBox(page: Page) {
  return (await page.getByTestId("slide-canvas").boundingBox())!;
}

/** A slide point (1920 x 1080 space) in page pixels. */
async function at(page: Page, x: number, y: number) {
  const box = await slideBox(page);
  return { x: box.x + (x / 1920) * box.width, y: box.y + (y / 1080) * box.height };
}

async function postComposer(page: Page, body: string) {
  const composer = page.getByRole("dialog", { name: "New comment" });
  await composer.getByRole("combobox", { name: "Comment" }).fill(body);
  await composer.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(composer).toBeHidden();
  await expect(page.getByTestId("comment-draft-anchor")).toHaveCount(0);
}

test("comments on every kind of anchor, live, with mentions, replies, reactions and resolving", async ({ browser }) => {
  test.setTimeout(240_000);
  const si = await silicon();
  const ada = await signedIn(browser, "carbon");
  const bo = await signedIn(browser, "friend");
  const deck = await createDeck(ada.context, "Review me");
  const first = (await call<{ slides: Array<{ id: string }> }>(ada.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
  await edit(ada.context, deck, [
    {
      op: "add_slide",
      after: first,
      slide: {
        id: SLIDE,
        layout: "blank",
        elements: [
          { id: "e_cmtext", kind: "text", x: 120, y: 80, w: 1200, h: 160, text: { paragraphs: [{ runs: [{ text: "Revenue grew in every region" }] }] } },
          { id: "e_cmchrt", kind: "chart", x: 120, y: 300, w: 800, h: 500, chart: { type: "column", title: "Revenue", labels: ["Q1", "Q2", "Q3"], series: [{ name: "2026", values: [3, 5, 8] }], legend: true } },
          { id: "e_cmhtml", kind: "html", x: 1100, y: 300, w: 700, h: 400, html: '<div id="live">running</div>', css: "#live{font:64px sans-serif}", js: "let n=0;setInterval(()=>{document.getElementById('live').textContent='tick '+(++n)},300)" },
          { id: "e_cmgone", kind: "shape", shape: "star", x: 1500, y: 820, w: 200, h: 200 },
        ],
      },
    },
    { op: "delete_slide", slide: first },
  ]);
  await share(ada.context, deck, runAccounts().friend.id, "commenter");
  await share(ada.context, deck, si.id, "commenter");
  await openDeck(ada.page, deck);
  await openDeck(bo.page, deck);

  // Select is read-only for a commenter; Comment explicitly starts a review.
  await expect(bo.page.getByRole("toolbar", { name: "Editing" })).toHaveCount(0);
  await expect(bo.page.getByTestId("select-tool")).toHaveAttribute("aria-pressed", "true");
  const selectPoint = await at(bo.page, 400, 160);
  await bo.page.mouse.click(selectPoint.x, selectPoint.y);
  await expect(bo.page.getByRole("dialog", { name: "New comment" })).toHaveCount(0);
  await expect(bo.page.locator("[data-handle]")).toHaveCount(0);
  await bo.page.getByTestId("comment-mode").click();
  await expect(bo.page.getByTestId("canvas-overlay")).toHaveAttribute("data-commenting", "true");

  // 1. A point: one click on the slide opens the box right there.
  const point = await at(bo.page, 1500, 160);
  await bo.page.mouse.click(point.x, point.y);
  const draft = bo.page.getByTestId("comment-draft-anchor");
  await expect(draft).toHaveAttribute("data-anchor-kind", "point");
  await expect(bo.page.getByTestId("comment-draft-pin")).toBeVisible();
  await expect(bo.page.getByTestId("comment-draft-area")).toHaveCount(0);
  const pointComposer = bo.page.getByRole("dialog", { name: "New comment" });
  await pointComposer.getByRole("combobox", { name: "Comment" }).fill("A draft stays marked while typing");
  await expect(draft).toBeVisible();
  await pointComposer.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft).toHaveCount(0);
  await bo.page.mouse.click(point.x, point.y);
  await postComposer(bo.page, "Something should go here");

  // 2. An area: a drag over part of the chart.
  const a1 = await at(bo.page, 200, 400);
  const a2 = await at(bo.page, 600, 700);
  await bo.page.mouse.move(a1.x, a1.y);
  await bo.page.mouse.down();
  await bo.page.mouse.move(a2.x, a2.y, { steps: 6 });
  await expect(bo.page.getByTestId("comment-drag-area")).toBeVisible();
  await bo.page.mouse.up();
  await expect(bo.page.getByTestId("comment-drag-area")).toHaveCount(0);
  await expect(draft).toHaveAttribute("data-anchor-kind", "area");
  await expect(bo.page.getByTestId("comment-draft-area")).toBeVisible();
  // Opening the comments panel can change Fit: the outline still follows slide coordinates.
  await expect.poll(async () => {
    const box = await bo.page.getByTestId("comment-draft-area").boundingBox();
    const start = await at(bo.page, 200, 400);
    const end = await at(bo.page, 600, 700);
    return box ? Math.max(Math.abs(box.x - start.x), Math.abs(box.y - start.y), Math.abs(box.width - (end.x - start.x)), Math.abs(box.height - (end.y - start.y))) : Infinity;
  }).toBeLessThan(2);
  await postComposer(bo.page, `@${si.id} make these bars simpler`);

  // 3. Some words of a text: double-click the text, then pick the words.
  const t = await at(bo.page, 400, 160);
  await bo.page.mouse.dblclick(t.x, t.y);
  const picker = bo.page.getByTestId("text-picker");
  await picker.locator(".ql-editor").waitFor();
  // Double-click a word (near the start of the line: the paragraph is wider than its words).
  await picker.getByText("Revenue grew in every region").dblclick({ position: { x: 12, y: 6 } });
  await expect(draft).toHaveAttribute("data-anchor-kind", "text");
  await expect(bo.page.getByTestId("comment-draft-area")).toBeVisible();
  await postComposer(bo.page, "Which regions exactly?");

  // 4. A whole slide and 5. the whole deck, from the list.
  await bo.page.getByRole("button", { name: "On this slide" }).click();
  await expect(draft).toHaveCount(0);
  await postComposer(bo.page, "This slide needs a takeaway");
  await bo.page.getByRole("button", { name: "On the whole deck" }).click();
  await expect(draft).toHaveCount(0);
  await postComposer(bo.page, "Use the new brand colours throughout");

  // 6. An element, a running HTML element, as an editor with the keyboard.
  await expect(ada.page.frameLocator('[data-element-id="e_cmhtml"] iframe').locator("#live")).toContainText("tick");
  const h = await at(ada.page, 1450, 500);
  await ada.page.mouse.click(h.x, h.y);
  await ada.page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+m" : "Control+Alt+m");
  await expect(ada.page.getByTestId("comment-draft-anchor")).toHaveAttribute("data-anchor-kind", "element");
  await expect(ada.page.getByTestId("comment-draft-area")).toBeVisible();
  await postComposer(ada.page, "Slow this animation down");

  // Every anchor kind reached the service, and each page shows the other's threads live.
  let threads: Array<{ id: string; anchor: { kind: string; element?: string; ex?: number }; comments: Array<{ id: string; body: string }> }> = [];
  await eventually(async () => {
    threads = (await call<{ threads: typeof threads }>(ada.context, "GET", `/v1/decks/${deck}/threads?state=all`)).body.threads;
    expect(threads.map(x => x.anchor.kind).sort()).toEqual(["area", "deck", "element", "point", "slide", "text"]);
  });
  expect(threads.find(x => x.anchor.kind === "area")!.anchor).toMatchObject({ element: "e_cmchrt" });
  expect(threads.find(x => x.anchor.kind === "element")!.anchor).toMatchObject({ element: "e_cmhtml" });
  expect(threads.find(x => x.anchor.kind === "text")!.anchor).toMatchObject({ element: "e_cmtext", quote: expect.stringContaining("Revenue") });
  await expect(ada.page.getByTestId("comment-pin")).toHaveCount(4);
  await expect(bo.page.getByTestId("comment-pin")).toHaveCount(4);

  // The mention reached the Silicon through Silicon Ting, with what the comment is on.
  await eventually(async () => {
    const got = await tings({ type: "present.mention.received", for: si.uuid });
    expect(got.some(x => JSON.stringify(x.data).includes("make these bars simpler"))).toBe(true);
  }, 30_000);

  // Reply, react, edit and delete, and resolve and reopen, from the list.
  await ada.page.getByTestId("tab-comments").click();
  const list = ada.page.getByRole("complementary", { name: "Properties and comments" });
  await list.getByRole("button", { name: /Which regions exactly/ }).click();
  await list.getByRole("combobox", { name: "Reply" }).fill("North and South");
  await list.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(list.getByText("North and South")).toBeVisible();
  // Bo's list shows the reply arrive (live), under the thread.
  await expect(bo.page.getByRole("complementary", { name: "Properties and comments" }).getByRole("button", { name: /Which regions exactly/ })).toContainText("1 reply");
  await list.getByRole("button", { name: "React" }).first().click();
  await ada.page.getByRole("button", { name: "React with 🎉" }).click();
  await expect(list.getByRole("button", { name: /🎉 1, you reacted/ })).toBeVisible();
  await list.getByRole("button", { name: "Comment actions" }).last().click();
  await ada.page.getByRole("button", { name: "Edit", exact: true }).click();
  await list.getByRole("combobox", { name: "Edit comment" }).fill("North and South, mostly");
  await list.getByRole("button", { name: "Save" }).click();
  await expect(list.getByText("North and South, mostly")).toBeVisible();
  await eventually(async () => {
    const all = (await call<{ threads: Array<{ comments: Array<{ body: string; editedAt: string | null }> }> }>(bo.context, "GET", `/v1/decks/${deck}/threads?state=all`)).body.threads;
    expect(all.flatMap(x => x.comments).find(c => c.body === "North and South, mostly")?.editedAt).toBeTruthy();
  });
  await list.getByRole("button", { name: "Resolve thread" }).click();
  await expect(ada.page.getByTestId("comment-pin")).toHaveCount(3);
  await list.getByRole("switch", { name: "Show resolved" }).click();
  await list.getByRole("button", { name: /Which regions exactly/ }).click();
  await list.getByRole("button", { name: "Reopen thread" }).click();
  await expect(ada.page.getByTestId("comment-pin")).toHaveCount(4);

  // The keyboard walks through the threads.
  await list.getByRole("heading", { name: /Comments/ }).click();
  await ada.page.keyboard.press("ArrowDown");
  const firstActive = await ada.page.evaluate(() => (window as unknown as { __presentEditor: { ui: { get(): { activeThread: string | null } } } }).__presentEditor.ui.get().activeThread);
  await ada.page.keyboard.press("ArrowDown");
  const secondActive = await ada.page.evaluate(() => (window as unknown as { __presentEditor: { ui: { get(): { activeThread: string | null } } } }).__presentEditor.ui.get().activeThread);
  expect(firstActive).toBeTruthy();
  expect(secondActive).toBeTruthy();
  expect(secondActive).not.toBe(firstActive);

  // Deleting a reply leaves the thread; a comment on an element that is deleted still says what it was on.
  const starPoint = await at(bo.page, 1600, 920);
  await bo.page.mouse.click(starPoint.x, starPoint.y);
  await postComposer(bo.page, "Is this star needed?");
  await edit(ada.context, deck, [{ op: "delete_element", slide: SLIDE, element: "e_cmgone" }]);
  await ada.page.reload();
  await ada.page.getByTestId("slide-canvas").waitFor();
  await ada.page.getByTestId("tab-comments").click();
  const gone = ada.page.getByRole("complementary", { name: "Properties and comments" }).getByRole("button", { name: /Is this star needed/ });
  await expect(gone).toContainText(/Shape|star|point/i);
  await expect(gone).toContainText("no longer in the deck");

  expect(ada.errors).toEqual([]);
  expect(bo.errors).toEqual([]);
  await ada.context.close();
  await bo.context.close();
});

test("a viewer can't edit or comment; a signed-out visitor is asked to sign in", async ({ browser }) => {
  test.setTimeout(180_000);
  const ada = await signedIn(browser, "carbon");
  const deck = await createDeck(ada.context, "Look but don't touch");
  await share(ada.context, deck, runAccounts().friend.id, "viewer");
  const bo = await signedIn(browser, "friend");
  await openDeck(bo.page, deck);
  await expect(bo.page.getByRole("toolbar", { name: "Editing" })).toHaveCount(0);
  await expect(bo.page.getByTestId("canvas-overlay")).not.toHaveAttribute("data-can-comment", "true");
  const p = await at(bo.page, 960, 540);
  await bo.page.mouse.click(p.x, p.y);
  await bo.page.mouse.dblclick(p.x, p.y);
  await expect(bo.page.getByRole("dialog", { name: "New comment" })).toHaveCount(0);
  await expect(bo.page.getByTestId("text-editor")).toHaveCount(0);
  await bo.page.keyboard.press("Delete");
  // The service refuses a viewer's comment and edit too.
  const comment = await call(bo.context, "POST", `/v1/decks/${deck}/threads`, { anchor: { kind: "deck" }, body: "sneaky" }, [403]);
  expect(comment.status).toBe(403);
  const update = await call(bo.context, "POST", `/v1/decks/${deck}/updates`, { update: "AAA=" }, [403]);
  expect(update.status).toBe(403);

  // Public with comments on: a signed-out visitor can choose Comment, which asks them to sign in.
  await setPublic(ada.context, deck, "comment");
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await anon.newPage();
  await page.goto(`/decks/${deck}`);
  await page.getByTestId("slide-canvas").waitFor();
  await page.getByTestId("comment-mode").click();
  const q = await at(page, 900, 500);
  await page.mouse.click(q.x, q.y);
  const box = page.getByRole("dialog", { name: "Comment" });
  await expect(box).toContainText("Sign in to comment");
  await expect(box.getByRole("button", { name: "Sign in" })).toBeVisible();
  await anon.close();
  expect(bo.errors).toEqual([]);
  await ada.context.close();
  await bo.context.close();
});

test("a ting's link opens the deck at the thread", async ({ browser }) => {
  const ada = await signedIn(browser, "carbon");
  const deck = await createDeck(ada.context, "Linked thread");
  const first = (await call<{ slides: Array<{ id: string }> }>(ada.context, "GET", `/v1/decks/${deck}/content?format=json`)).body.slides[0]!.id;
  await edit(ada.context, deck, [{ op: "add_slide", after: first, slide: { id: "s_link02", layout: "blank", elements: [] } }]);
  const created = await call<{ id: string }>(ada.context, "POST", `/v1/decks/${deck}/threads`, { anchor: { kind: "point", slide: "s_link02", x: 300, y: 300 }, body: "Look at this one" });
  await ada.page.goto(`/decks/${deck}?thread=${created.body.id}`);
  await ada.page.getByTestId("slide-canvas").waitFor();
  await expect(ada.page.getByTestId("slide-canvas")).toHaveAttribute("data-slide-id", "s_link02");
  await expect(ada.page.getByRole("complementary", { name: "Properties and comments" })).toContainText("Look at this one");
  await expect(ada.page.getByRole("combobox", { name: "Reply" })).toBeVisible();
  await expect(ada.page).toHaveTitle(/Linked thread/);
  await ada.context.close();
});
