/**
 * Helpers for the editor's browser tests (e2e/editor*.spec.ts): opening a deck in the editor and waiting for its live
 * connection, sharing it, reading it back from the service, a Silicon that edits through the ops API with its own
 * token, and the Ting stand-in's record of tings.
 *
 * The Silicon is minted once at the local Silicon Accounts stack (e2e/cli/mint.mts: a custodian Carbon, the Silicon,
 * its STK) and kept in the lane's auth folder, so later runs only exchange a fresh short-lived token for it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { call } from "./pages-support";
import { AUTH_DIR, uniqueEmail } from "./support";

export const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4341";
export const TING = process.env.E2E_TING_URL ?? "http://127.0.0.1:4343";
const STACK = JSON.parse(readFileSync(resolve(__dirname, "../../e2e/stack/test-stack.json"), "utf8")) as { accounts_api_url: string; accounts_checkout: string };

/** Opens a deck in the editor and waits until it is live (the first sync with the service is done). */
export async function openDeck(page: Page, deck: string, query = ""): Promise<void> {
  await page.goto(`/decks/${deck}${query}`);
  await page.getByTestId("slide-canvas").waitFor({ timeout: 30_000 });
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", /live|saving/, { timeout: 30_000 });
}

/** Waits until every change made in this page has reached the service. */
export async function settled(page: Page): Promise<void> {
  await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "live", { timeout: 20_000 });
  await page.waitForFunction(() => (window as unknown as { __presentEditor?: { provider: { idle: boolean } } }).__presentEditor?.provider.idle === true, undefined, { timeout: 20_000 });
}

export async function share(context: BrowserContext, deck: string, to: string, role: "editor" | "commenter" | "viewer"): Promise<void> {
  await call(context, "POST", `/v1/decks/${deck}/access`, { to, role });
}

export async function setPublic(context: BrowserContext, deck: string, mode: "off" | "view" | "comment" | "edit"): Promise<void> {
  await call(context, "PUT", `/v1/decks/${deck}/public`, { mode });
}

type DeckJson = { slides: Array<{ id: string; notes: string; skipped: boolean; section: string | null; transition: unknown; layout: string; elements: Array<Record<string, unknown> & { id: string; kind: string }> }>; theme: { name: string }; master: { elements: unknown[] } };

/** The deck as the service has it now. */
export async function deckJson(context: BrowserContext, deck: string): Promise<DeckJson> {
  const { body } = await call<DeckJson & { deck?: DeckJson; content?: DeckJson }>(context, "GET", `/v1/decks/${deck}/content?format=json`);
  return (body.content ?? body.deck ?? body) as DeckJson;
}

/** All the characters of a rich text, paragraphs joined by "\n". */
export function plain(rich: unknown): string {
  const rt = rich as { paragraphs?: Array<{ runs: Array<{ text: string }> }> } | undefined;
  return (rt?.paragraphs ?? []).map(p => p.runs.map(r => r.text).join("")).join("\n");
}

// ---- a Silicon ----

interface SiliconRecord {
  id: string;
  uuid: string;
  stk: string;
}

export interface Silicon {
  id: string;
  uuid: string;
  token: string;
  /** A call to the service as the Silicon (straight to the service, as the CLI does). */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
}

function mint(args: string[]): Record<string, string> {
  const tsx = `${STACK.accounts_checkout}/testkit/node_modules/.bin/tsx`;
  const out = execFileSync(tsx, [resolve(__dirname, "../../e2e/cli/mint.mts"), ...args], { encoding: "utf8", timeout: 90_000 });
  return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, string>;
}

/** The test Silicon (si:…, "Deck Designer"), signed in to Present with a fresh token. */
export async function silicon(): Promise<Silicon> {
  const file = `${AUTH_DIR}/silicon.json`;
  let record: SiliconRecord | null = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SiliconRecord) : null;
  if (!record) {
    const custodian = mint(["carbon", "--email", uniqueEmail("custodian")]);
    const id = `si:pe-designer-${Date.now().toString(36)}`;
    const made = mint(["silicon", "--carbon-token", custodian.access_token!, "--id", id, "--name", "Deck Designer"]);
    record = { id: made.id!, uuid: made.uuid!, stk: made.stk! };
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  const { slt } = mint(["slt", "--silicon", record.id, "--stk", record.stk, "--app", "present"]);
  const response = await fetch(`${STACK.accounts_api_url}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:silicon:params:oauth:grant-type:slt", slt: slt!, client_id: "present" }),
  });
  const tokens = (await response.json()) as { access_token?: string };
  if (!tokens.access_token) throw new Error(`the Silicon's short-lived token was not exchanged: ${response.status} ${JSON.stringify(tokens)}`);
  const token = tokens.access_token;
  const callAs = async <T,>(method: string, path: string, body?: unknown) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  };
  // The first request signs the Silicon in to Present (and enrols it for tings).
  await callAs("GET", "/v1/me");
  return { id: record.id, uuid: record.uuid, token, call: callAs };
}

// ---- tings ----

export interface Ting {
  type: string;
  for: string;
  key: string;
  data: Record<string, unknown>;
}

export async function tings(query: { type?: string; for?: string } = {}): Promise<Ting[]> {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]);
  const response = await fetch(`${TING}/_tings?${params.toString()}`);
  const body = (await response.json()) as Ting[] | { tings?: Ting[] };
  return Array.isArray(body) ? body : (body.tings ?? []);
}

/** The deck's id from the editor page's URL. */
export function deckIdOf(page: Page): string {
  return new URL(page.url()).pathname.split("/")[2]!;
}
