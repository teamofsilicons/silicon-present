/**
 * Once per run: two Carbons sign in to the kit through the hosted pages with an email code (new accounts each run), and
 * their browser state is kept in test-results/.auth/. Specs start from their Silicon Accounts sign-in and continue as
 * them ("Continue as …"), so the run spends two codes of the shared stack's budget, not one per spec.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { test as setup } from "@playwright/test";
import { accountsFile, AUTH_DIR, BASE, sameOrigin, sessionOf, signIn, statePath, uniqueEmail, type Who } from "./support";

/**
 * The Silicon Accounts browser sign-ins last for days, so a run reuses the last run's two Carbons when they are under
 * 12 hours old (E2E_FRESH_ACCOUNTS=1 signs new ones in). That keeps repeated runs off the shared stack's code budget.
 */
function reusable(): boolean {
  if (process.env.E2E_FRESH_ACCOUNTS) return false;
  if (!existsSync(accountsFile) || !existsSync(statePath("carbon")) || !existsSync(statePath("friend"))) return false;
  return Date.now() - statSync(accountsFile).mtimeMs < 12 * 3600_000;
}

setup("sign two Carbons in once for the whole run", async ({ browser }) => {
  if (reusable()) return;
  mkdirSync(AUTH_DIR, { recursive: true });
  const accounts: Record<string, { email: string; id: string }> = {};
  for (const who of ["carbon", "friend"] as Who[]) {
    const context = await browser.newContext({ baseURL: BASE });
    const page = await context.newPage();
    const email = uniqueEmail(who);
    await signIn(page, email);
    accounts[who] = { email, id: (await sessionOf(context)).account!.id };
    await context.storageState({ path: statePath(who) });
    // The kit's own sign-in ends here (revoked); the Silicon Accounts sign-in stays for "Continue as".
    await context.request.post("/auth/sign-out", { headers: sameOrigin() });
    await context.close();
  }
  writeFileSync(accountsFile, `${JSON.stringify(accounts, null, 2)}\n`);
});
