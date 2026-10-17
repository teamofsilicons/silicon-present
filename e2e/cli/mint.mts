// Test identities at the LOCAL Silicon Accounts test stack (e2e/stack/test-stack.json), for the CLI suite.
// Runs with the Silicon Accounts testkit's tsx and library:
//
//   $ACCOUNTS/testkit/node_modules/.bin/tsx e2e/cli/mint.mts <command> ...
//
//   carbon --email ada@example.test
//       -> {uuid, id, access_token, refresh_token}: a first-party session; creates the Carbon if new
//   silicon --carbon-token <first-party token> --id si:cli-writer-1 --name "Writer"
//       -> {uuid, id, stk}: a Silicon in the Carbon's custody (an existing id gets a fresh STK)
//   slt --silicon si:cli-writer-1 --stk stk_... [--app present]
//       -> {slt, app_id, expires_at}: a short-lived token for the app
//   approve --carbon-token <first-party token> --code WDJB-MJHT
//       -> {approved: true}: approves a device sign-in as the Carbon
//
// Every command prints one JSON object on stdout. Email codes are limited (10 per address, 30 per network in
// 10 minutes), so the suite signs each Carbon in once per run.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const here = new URL('.', import.meta.url).pathname;
const stackFile = process.env.PRESENT_TEST_STACK ?? `${here}../stack/test-stack.json`;
const STACK = JSON.parse(readFileSync(stackFile, 'utf8')) as {
  accounts_api_url: string;
  mock_messaging_url: string;
  accounts_checkout: string;
};
for (const url of [STACK.accounts_api_url, STACK.mock_messaging_url]) {
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname)) {
    console.error(`mint: ${url} is not on this machine; this helper only talks to a local stack`);
    process.exit(2);
  }
}
const testkit = await import(pathToFileURL(`${STACK.accounts_checkout}/testkit/lib/index.ts`).href);
const { AccountsClient, MockMessagingClient, signUpCarbon } = testkit;
const accounts = new AccountsClient(STACK.accounts_api_url);
const messaging = new MockMessagingClient(STACK.mock_messaging_url);

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) {
    console.error(`mint: --${name} is required`);
    process.exit(2);
  }
  return v;
}
const out = (v: unknown) => console.log(JSON.stringify(v));

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${accounts.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const cmd = process.argv[2];
if (cmd === 'carbon') {
  const email = arg('email');
  let tokens, me;
  try {
    const r = await accounts.cliLogin(messaging, { email });
    tokens = r.tokens;
    me = await r.session.me();
  } catch {
    const created = await signUpCarbon({ accounts, messaging, email });
    tokens = (await accounts.cliLogin(messaging, { email })).tokens;
    me = created.me;
  }
  out({ uuid: me.uuid, id: me.id, kind: 'carbon', email, access_token: tokens.access_token, refresh_token: tokens.refresh_token });
} else if (cmd === 'silicon') {
  const token = arg('carbon-token');
  const id = arg('id');
  const name = arg('name', id);
  const created = await api('POST', '/v1/me/silicons', token, { id, display_name: name });
  if (created.status === 201 || created.status === 200) {
    out({ uuid: created.body.silicon.uuid, id: created.body.silicon.id, stk: created.body.stk });
  } else {
    // Already exists (an earlier run): find it among the Carbon's Silicons and rotate its STK.
    const list = await api('GET', '/v1/me/silicons', token);
    const items = (list.body?.items ?? list.body?.silicons ?? list.body ?? []) as any[];
    const s = items.find((x) => x.id === id || x.silicon?.id === id);
    if (!s) throw new Error(`could not create ${id} (${created.status} ${JSON.stringify(created.body)}) and it is not among the Carbon's Silicons`);
    const uuid = s.uuid ?? s.silicon?.uuid;
    const rot = await api('POST', `/v1/me/silicons/${uuid}/stk`, token, {});
    if (rot.status !== 200) throw new Error(`STK rotation for ${id} refused: ${rot.status} ${JSON.stringify(rot.body)}`);
    out({ uuid, id, stk: rot.body.stk });
  }
} else if (cmd === 'slt') {
  const tokens = await accounts.siliconLogin(arg('silicon'), arg('stk'), 'present cli e2e');
  const r = await api('POST', '/v1/me/short-lived-tokens', tokens.access_token, { app_id: arg('app', 'present') });
  if (r.status !== 200 && r.status !== 201) throw new Error(`short-lived token refused: ${r.status} ${JSON.stringify(r.body)}`);
  out(r.body);
} else if (cmd === 'approve') {
  const code = arg('code').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const r = await api('POST', `/v1/device/${code}/approve`, arg('carbon-token'));
  if (r.status >= 300) throw new Error(`device approval refused: ${r.status} ${JSON.stringify(r.body)}`);
  out({ approved: true });
} else {
  console.error('usage: mint.mts carbon|silicon|slt|approve (see the header of this file)');
  process.exit(2);
}
