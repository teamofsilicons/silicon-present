/**
 * Helpers for Present's own browser tests (e2e/pages*.spec.ts): a browser context signed in to Present as one of the
 * run's two Carbons, and calls to the service through this site's API proxy the way the pages make them (same origin,
 * the sealed cookie), for setting up decks quickly.
 */
import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { accountsSession, appConfig, BASE, runAccounts, sameOrigin, signIn, watchErrors, type Who } from "./support";

export interface Signed {
  context: BrowserContext;
  page: Page;
  id: string;
  errors: string[];
}

/** A context signed in to Present as `who` ("Continue as" on the hosted pages: no email code). */
export async function signedIn(browser: Browser, who: Who, options: Parameters<Browser["newContext"]>[0] = {}): Promise<Signed> {
  const context = await accountsSession(browser, who, { viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await signIn(page, runAccounts()[who].email, appConfig.home);
  return { context, page, id: runAccounts()[who].id, errors };
}

/** A call to the service through /api, as the context's account. Fails the test on an error status unless `allow`. */
export async function call<T = unknown>(context: BrowserContext, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; body: T }> {
  const response = await context.request.fetch(`${BASE}/api${path}`, {
    method,
    headers: sameOrigin(body === undefined ? {} : { "Content-Type": "application/json" }),
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok() && !allow.includes(response.status())) throw new Error(`${method} ${path} answered ${response.status()}: ${text.slice(0, 400)}`);
  return { status: response.status(), body: parsed as T };
}

/** The deck (or folder) out of a create answer that may wrap it. */
export function idOf(answer: unknown, key: "deck" | "folder" = "deck"): string {
  const value = answer as Record<string, unknown>;
  const inner = (value[key] && typeof value[key] === "object" ? value[key] : value) as { id?: string };
  if (!inner.id) throw new Error(`no ${key} id in ${JSON.stringify(answer).slice(0, 200)}`);
  return inner.id;
}

export async function createDeck(context: BrowserContext, title: string, folder?: string): Promise<string> {
  const { body } = await call(context, "POST", "/v1/decks", { title, ...(folder ? { folder } : {}) });
  return idOf(body);
}

export async function createFolder(context: BrowserContext, name: string, parent?: string): Promise<string> {
  const { body } = await call(context, "POST", "/v1/folders", { name, ...(parent ? { parent } : {}) });
  return idOf(body, "folder");
}

/** One edit request of ops (docs/architecture.md "Edit ops"); returns the deck's version after it. */
export async function edit(context: BrowserContext, deck: string, ops: unknown[], summary?: string): Promise<number> {
  const { body } = await call<{ version?: number }>(context, "POST", `/v1/decks/${deck}/edits`, { ops, ...(summary ? { summary } : {}) });
  return body?.version ?? 0;
}

/** A text element as an add_element op takes it. */
export function textElement(id: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "text", x: 160, y: 160, w: 1600, h: 200, rotation: 0, text: { paragraphs: [{ runs: [{ text, size: 72 }] }] }, ...extra };
}

/** A deck with `slides` slides, each a title text; returns the slide ids in order. */
export async function deckWithSlides(context: BrowserContext, deck: string, slides: Array<{ id: string; title: string; notes?: string; skipped?: boolean; animated?: boolean; transition?: boolean; html?: boolean }>): Promise<string[]> {
  const ops: unknown[] = [];
  let after: string | null = null;
  for (const slide of slides) {
    // Ids are "e_" + 6 characters (docs/architecture.md): a letter for the role, then the slide id's last five.
    const tail = slide.id.slice(-5);
    const elements: unknown[] = [textElement(`e_t${tail}`, slide.title)];
    if (slide.animated) elements.push(textElement(`e_a${tail}`, `${slide.title} appears on click`, { y: 520, animation: { effect: "fade", trigger: "click", order: 1, duration: 300, delay: 0 } }));
    if (slide.html) elements.push({ id: `e_h${tail}`, kind: "html", x: 160, y: 520, w: 800, h: 300, rotation: 0, html: '<div id="out">waiting</div>', css: "#out{font:48px sans-serif}", js: "document.getElementById('out').textContent='HTML ran '+(1+1);" });
    ops.push({ op: "add_slide", after, slide: { id: slide.id, layout: "blank", notes: slide.notes ?? "", skipped: !!slide.skipped, transition: slide.transition ? { type: "fade", duration: 300 } : null, elements } });
    after = slide.id;
  }
  await edit(context, deck, ops, "Built the test slides");
  return slides.map(slide => slide.id);
}

/** Waits until `fn` stops throwing (for things that settle over the live connection). */
export async function eventually(fn: () => Promise<void>, timeout = 15_000): Promise<void> {
  await expect(async () => fn()).toPass({ timeout });
}
