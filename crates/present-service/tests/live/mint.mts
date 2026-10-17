// Present tokens for a Carbon and a Silicon on the LOCAL Silicon Accounts test stack (e2e/stack/test-stack.json),
// for tests/live_stack.rs. Run with the Accounts testkit's tsx:
//
//   ~/Documents/silicon/silicon-accounts/testkit/node_modules/.bin/tsx crates/present-service/tests/live/mint.mts \
//     --email present-service-tests@example.com --silicon si:present-svc-tester --cache .dev/live-mint.json
//
// Prints { carbon: {uuid, id, access_token}, silicon: {uuid, id, access_token} }. The Carbon signs in to `present`
// through the hosted pages with an email code (creating the Carbon on first use); the Silicon is created once in
// its care (its STK is kept in --cache) and signs in to `present` with a short-lived token. Local stacks only.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(new URL('../../../..', import.meta.url).pathname);
const accountsDir = process.env.SILICON_ACCOUNTS_DIR ?? join(homedir(), 'Documents/silicon/silicon-accounts');
const kit = await import(pathToFileURL(join(accountsDir, 'testkit', 'lib', 'index.ts')).href);
const STACK = JSON.parse(readFileSync(process.env.PRESENT_TEST_STACK ?? join(repo, 'e2e/stack/test-stack.json'), 'utf8'));
const api: string = STACK.accounts_api_url;
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(api)) throw new Error(`${api} is not a local stack`);
const accounts = new kit.AccountsClient(api);
const messaging = new kit.MockMessagingClient(STACK.mock_messaging_url);
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : d;
  if (!v) throw new Error(`--${n} is required`);
  return v;
};
const email = arg('email');
const siliconId = arg('silicon');
const cachePath = arg('cache', join(repo, '.dev/live-mint.json'));
const cache: Record<string, { stk: string; uuid: string }> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const present = accounts.app('present', STACK.apps.present.app_secret);
const redirect = 'http://127.0.0.1:4320/auth/callback';

async function carbonFirstParty() {
  try {
    return await accounts.cliLogin(messaging, { email });
  } catch {
    await kit.signUpCarbon({ accounts, messaging, email });
    return await accounts.cliLogin(messaging, { email });
  }
}

// The Silicon (created once, in the Carbon's care).
let sil = cache[siliconId];
if (!sil) {
  const { session } = await carbonFirstParty();
  const created = await session.createSilicon({ id: siliconId, display_name: 'Present test Silicon' }, randomUUID());
  sil = { stk: created.stk, uuid: created.silicon.uuid };
  cache[siliconId] = sil;
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
}
const siliconTokens = await accounts.siliconLogin(siliconId, sil.stk, 'present service tests');
const sltRes = await fetch(`${accounts.url}/v1/me/short-lived-tokens`, {
  method: 'POST',
  headers: { authorization: `Bearer ${siliconTokens.access_token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ app_id: 'present' }),
});
const slt = await sltRes.json();
if (!sltRes.ok) throw new Error(`short-lived token refused: ${sltRes.status} ${JSON.stringify(slt)}`);
const siliconPresent = await present.exchangeSlt(slt.slt);

// The Carbon, through the hosted sign-in for present.
let signin;
try {
  signin = await kit.signInWithCode({ accounts, messaging, appId: 'present', email, redirectUri: redirect, scope: 'email' });
} catch {
  await kit.signUpCarbon({ accounts, messaging, email });
  signin = await kit.signInWithCode({ accounts, messaging, appId: 'present', email, redirectUri: redirect, scope: 'email' });
}
if (!signin.code) throw new Error(`the sign-in ended without a code: ${signin.error}`);
const carbonPresent = await present.exchangeCode(signin.code, signin.redirectUri, signin.codeVerifier);

const who = (t: any) => ({ uuid: t.account?.uuid, id: t.account?.id, access_token: t.access_token });
console.log(JSON.stringify({ carbon: who(carbonPresent), silicon: who(siliconPresent) }));
