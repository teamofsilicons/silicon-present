// A pool of test Carbons and Silicons at the LOCAL Silicon Accounts test stack (e2e/stack/test-stack.json), so many
// test agents can act as real accounts at once without spending email codes (the stack allows 30 per network in
// 10 minutes). Run with the Accounts testkit's tsx:
//
//   T=~/Documents/silicon/silicon-accounts/testkit/node_modules/.bin/tsx
//   $T e2e/identities/pool.mts init [--carbons 6] [--silicons 10]   create the pool (costs ~2 email codes per Carbon)
//   $T e2e/identities/pool.mts list                                  names, ids and kinds
//   $T e2e/identities/pool.mts token <name>                          fresh `present` tokens + account, as JSON
//   $T e2e/identities/pool.mts relogin <carbon-name>                  new sign-in for a Carbon (one email code)
//   $T e2e/identities/pool.mts slt <name>                            a single-use token for `present` (CLI --slt-stdin)
//   $T e2e/identities/pool.mts cookie <name> --secret <SESSION_SECRET> [--secure]
//        a sealed `present_session` cookie value for the web (the web's SESSION_SECRET), so a browser test can be
//        signed in as that account without the hosted pages
//
// Names: carbon-1 … carbon-N (custodian of every Silicon is carbon-1), silicon-1 … silicon-M. The pool lives in
// .dev/identities.json (git-ignored). Carbon first-party refresh tokens rotate on every use, so refreshing takes a
// lock (.dev/identities.lock) and writes the new token back before anyone else refreshes.
import { createCipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const here = new URL('.', import.meta.url).pathname;
const root = `${here}../..`;
const STACK = JSON.parse(readFileSync(process.env.PRESENT_TEST_STACK ?? `${here}../stack/test-stack.json`, 'utf8'));
const API: string = STACK.accounts_api_url;
const POOL = `${root}/.dev/identities.json`;
const LOCK = `${root}/.dev/identities.lock`;
for (const url of [API, STACK.mock_messaging_url]) {
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    console.error(`pool: ${url} is not on this machine; the pool only talks to a local stack`);
    process.exit(2);
  }
}

type Carbon = { name: string; kind: 'carbon'; email: string; uuid: string; id: string; rt: string };
type Silicon = { name: string; kind: 'silicon'; uuid: string; id: string; stk: string };
type Pool = { created_at: string; carbons: Carbon[]; silicons: Silicon[] };

const out = (v: unknown) => console.log(JSON.stringify(v));
class PoolError extends Error {}
const fail = (msg: string): never => { throw new PoolError(msg); };
function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) fail(`--${name} is required`);
  return v!;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function readPool(): Pool {
  if (!existsSync(POOL)) fail(`no pool yet: run \`pool.mts init\` first (${POOL})`);
  return JSON.parse(readFileSync(POOL, 'utf8'));
}
function writePool(pool: Pool) {
  const tmp = `${POOL}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pool, null, 2), { mode: 0o600 });
  renameSync(tmp, POOL);
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  for (;;) {
    try { mkdirSync(LOCK); break; } catch {
      // A lock older than 60 s belongs to a process that died mid-refresh.
      try { if (Date.now() - statSync(LOCK).mtimeMs > 60_000) { rmdirSync(LOCK); continue; } } catch { continue; }
      if (Date.now() - started > 120_000) fail(`timed out waiting for ${LOCK}`);
      await new Promise(r => setTimeout(r, 50 + Math.random() * 150));
    }
  }
  try { return await fn(); } finally { try { rmdirSync(LOCK); } catch { /* already gone */ } }
}

async function form(path: string, body: Record<string, string>) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) fail(`${path} answered ${res.status}: ${JSON.stringify(json)}`);
  return json as any;
}
async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

/** A first-party (silicon-accounts) access token for a pool member. */
async function firstParty(name: string): Promise<string> {
  const pool = readPool();
  const s = pool.silicons.find(x => x.name === name);
  if (s) {
    const res = await fetch(`${API}/v1/silicons/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id, stk: s.stk, client_label: 'present pool' }) });
    const json: any = await res.json().catch(() => null);
    if (!res.ok) fail(`Silicon sign-in for ${s.id} answered ${res.status}: ${JSON.stringify(json)}`);
    return json.access_token;
  }
  if (!pool.carbons.find(x => x.name === name)) fail(`no identity named ${name}; run \`pool.mts list\``);
  return withLock(async () => {
    const fresh = readPool();
    const c = fresh.carbons.find(x => x.name === name)!;
    const t = await form('/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: c.rt, client_id: 'silicon-accounts' });
    c.rt = t.refresh_token;
    writePool(fresh);
    return t.access_token as string;
  });
}

async function slt(name: string): Promise<string> {
  const token = await firstParty(name);
  const r = await api('POST', '/v1/me/short-lived-tokens', token, { app_id: 'present' });
  if (r.status !== 200 && r.status !== 201) fail(`short-lived token for ${name} refused: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.slt;
}

async function presentTokens(name: string) {
  const t = await form('/v1/oauth/token', { grant_type: 'urn:silicon:params:oauth:grant-type:slt', slt: await slt(name), client_id: 'present' });
  const now = Date.now();
  return {
    access_token: t.access_token as string,
    refresh_token: t.refresh_token as string,
    scope: (t.scope as string) ?? '',
    access_expires_at: now + (t.expires_in ?? 1800) * 1000,
    refresh_expires_at: t.refresh_expires_in ? now + t.refresh_expires_in * 1000 : now + 30 * 24 * 3600 * 1000,
    account: t.account ?? null,
  };
}

/** Same algorithm as web/lib/server/seal.ts: AES-256-GCM, HKDF-SHA256 key, purpose as additional data. */
function seal(value: unknown, purpose: string, secret: string): string {
  const key = Buffer.from(hkdfSync('sha256', secret, 'silicon-web-kit', 'cookie seal v1', 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
}

const cmd = process.argv[2];
async function main() {
if (cmd === 'init') {
  if (existsSync(POOL) && !flag('force')) fail(`${POOL} exists; pass --force to make a new pool`);
  const testkit = await import(pathToFileURL(`${STACK.accounts_checkout}/testkit/lib/index.ts`).href);
  const accounts = new testkit.AccountsClient(API);
  const messaging = new testkit.MockMessagingClient(STACK.mock_messaging_url);
  const nC = Number(arg('carbons', '6')), nS = Number(arg('silicons', '10'));
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const pool: Pool = { created_at: new Date().toISOString(), carbons: [], silicons: [] };
  for (let i = 1; i <= nC; i++) {
    const email = `present-pool-${stamp}-${i}@example.test`;
    let tokens: any, me: any;
    try {
      const r = await accounts.cliLogin(messaging, { email });
      tokens = r.tokens; me = await r.session.me();
    } catch {
      const created = await testkit.signUpCarbon({ accounts, messaging, email });
      tokens = (await accounts.cliLogin(messaging, { email })).tokens; me = created.me;
    }
    const names = ['Ada', 'Bo', 'Cy', 'Di', 'Ez', 'Fay', 'Gus', 'Hal'];
    await api('PATCH', '/v1/me', tokens.access_token, { display_name: `${names[(i - 1) % names.length]} Pool` });
    pool.carbons.push({ name: `carbon-${i}`, kind: 'carbon', email, uuid: me.uuid, id: me.id, rt: tokens.refresh_token });
    writePool(pool);
  }
  const custodian = await firstParty('carbon-1');
  // firstParty() rotated carbon-1's refresh token and wrote it to disk: continue from the file, never the stale copy.
  Object.assign(pool, readPool());
  for (let i = 1; i <= nS; i++) {
    const id = `si:present-pool-${stamp}-${i}`;
    const created = await api('POST', '/v1/me/silicons', custodian, { id, display_name: `Pool Silicon ${i}` });
    if (created.status !== 200 && created.status !== 201) fail(`creating ${id} answered ${created.status}: ${JSON.stringify(created.body)}`);
    pool.silicons.push({ name: `silicon-${i}`, kind: 'silicon', uuid: created.body.silicon.uuid, id: created.body.silicon.id, stk: created.body.stk });
    writePool(pool);
  }
  out({ pool: POOL, carbons: pool.carbons.map(c => c.id), silicons: pool.silicons.map(s => s.id) });
} else if (cmd === 'relogin') {
  const name = process.argv[3] ?? fail('usage: relogin <carbon-name>');
  const testkit = await import(pathToFileURL(`${STACK.accounts_checkout}/testkit/lib/index.ts`).href);
  const accounts = new testkit.AccountsClient(API);
  const messaging = new testkit.MockMessagingClient(STACK.mock_messaging_url);
  await withLock(async () => {
    const pool = readPool();
    const c = pool.carbons.find(x => x.name === name) ?? fail(`no Carbon named ${name}`);
    const r = await accounts.cliLogin(messaging, { email: c.email });
    c.rt = r.tokens.refresh_token;
    writePool(pool);
  });
  out({ relogin: name });
} else if (cmd === 'list') {
  const pool = readPool();
  out([...pool.carbons, ...pool.silicons].map(x => ({ name: x.name, kind: x.kind, id: x.id, uuid: x.uuid, ...(x.kind === 'carbon' ? { email: (x as Carbon).email } : {}) })));
} else if (cmd === 'token') {
  out(await presentTokens(process.argv[3] ?? fail('usage: token <name>')));
} else if (cmd === 'slt') {
  console.log(await slt(process.argv[3] ?? fail('usage: slt <name>')));
} else if (cmd === 'cookie') {
  const name = process.argv[3] ?? fail('usage: cookie <name> --secret <SESSION_SECRET>');
  const t = await presentTokens(name);
  const a = t.account ?? {};
  const pool = readPool();
  const who = [...pool.carbons, ...pool.silicons].find(x => x.name === name)!;
  const session = {
    v: 1, at: t.access_token, rt: t.refresh_token, ae: t.access_expires_at, re: t.refresh_expires_at, scope: t.scope,
    acct: {
      uuid: a.uuid ?? who.uuid, kind: a.kind ?? who.kind, id: a.id ?? who.id,
      display_name: a.display_name || a.id || who.id, pfp_url: a.pfp_url ?? null,
      custodian: a.custodian && a.custodian.uuid ? { uuid: a.custodian.uuid, id: a.custodian.id } : null,
    },
  };
  out({ name: flag('secure') ? '__Host-present_session' : 'present_session', value: seal(session, 'session', arg('secret')), account: session.acct, refresh_expires_at: t.refresh_expires_at });
} else {
  fail('usage: pool.mts init|list|token <name>|slt <name>|cookie <name> --secret <SESSION_SECRET> (see the header of this file)');
}
}
main().catch(e => {
  console.error(`pool: ${e instanceof PoolError ? e.message : (e && e.stack) || e}`);
  process.exit(1);
});
