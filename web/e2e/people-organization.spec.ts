import { expect, test } from "@playwright/test";
import { createDeck, signedIn } from "./pages-support";
import { BASE } from "./support";

test("trusted suggestions, recipient photos and organization settings work from the workspace", async ({ browser }) => {
  const user = await signedIn(browser, "carbon");
  const { page, context } = user;
  const testName = "Interface collaboration " + Date.now();
  const deck = await createDeck(context, testName);
  const a = {
    id: "si:reviewer.acme",
    kind: "silicon",
    uuid: "ac0eaf32-a853-46bf-94f5-9320654fe55a",
    displayName: "Design partner",
    pfp: "/v1/contacts/photos/ac0eaf32-a853-46bf-94f5-9320654fe55a",
    trust: 220,
  };
  const caps = { admin: true, owner: true, team_structure: true, team_members: true, team_admins: [] };
  const org = { org_id: "acme", name: "Acme", capabilities: caps };
  let connected = false;
  let saved = false;
  let team = "Design";
  const reply = (json: unknown) => ({ json });
  await page.route("**/api/v1/contacts/photos/*", (r) =>
    r.fulfill({
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZGcAAAAASUVORK5CYII=", "base64"),
    }),
  );
  await page.route("**/api/v1/contacts/connection", (r) => {
    connected = r.request().postDataJSON().connected;
    return r.fulfill(reply({ connected }));
  });
  await page.route(/\/api\/v1\/contacts(?:\?|$)/, (r) => {
    if (r.request().method() === "POST") {
      expect(r.request().postDataJSON()).toMatchObject({ id: a.uuid, name: "My collaborator", trust: 210 });
      saved = true;
    }
    return r.fulfill(
      reply({ connected, total: saved ? 1 : 0, items: saved ? [{ ...a, displayName: "My collaborator", trust: 210 }] : [] }),
    );
  });
  await page.route(/\/api\/v1\/people(?:\?|$)/, (r) => r.fulfill(reply({ connected: true, total: 1, items: [a] })));
  await page.route("**/api/v1/accounts/resolve?*", (r) => r.fulfill(reply({ account: a })));
  await page.route("**/api/v1/organizations", (r) =>
    r.fulfill(reply({ organizations: [org], share_targets: [{ type: "team", id: "acme/design", org_id: "acme", name: "Design" }] })),
  );
  await page.route("**/api/v1/organizations/acme", (r) =>
    r.fulfill(reply({ org, capabilities: caps, teams: [{ id: "design", name: team, members: [] }], members: [] })),
  );
  await page.route("**/api/v1/organizations/acme/actions", (r) => {
    const b = r.request().postDataJSON();
    expect(b.action).toBe("team_create");
    team = b.name;
    return r.fulfill(reply({ ok: true }));
  });
  let granted = false;
  await page.route("**/api/v1/decks/*/groups", (r) => {
    if (r.request().method() === "PUT") {
      expect(r.request().postDataJSON()).toEqual({ principal: "team:acme/design", role: "viewer" });
      granted = true;
    }
    return r.fulfill(
      reply({ groups: granted ? [{ principal: "team:acme/design", name: "Design", role: "viewer", inherited: false }] : [] }),
    );
  });
  try {
    await page.goto(BASE + "/contacts");
    await page.getByRole("button", { name: "Connect Silicon Contacts" }).click();
    await page.getByRole("combobox", { name: "Carbon or Silicon" }).fill("dsgn");
    await page.getByRole("option").filter({ hasText: "Design partner" }).click();
    await expect(page.getByLabel("Selected recipient").locator("img")).toBeVisible();
    await page.getByLabel("Saved name").fill("My collaborator");
    await page.getByLabel("Trust", { exact: true }).fill("210");
    await page.getByRole("button", { name: "Save contact", exact: true }).click();
    await expect(page.getByText("Trust 210", { exact: true })).toBeVisible();
    await page.goto(BASE + "/organizations");
    await expect(page.getByRole("heading", { name: "Organization settings" })).toBeVisible();
    await page.getByLabel("New team name").fill("Product");
    await page.getByRole("button", { name: "Create team" }).click();
    await expect(page.getByText("Team created.")).toBeVisible();
    await page.goto(BASE + "/decks/" + deck);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const invite = dialog.getByRole("combobox", { name: "Invite", exact: true });
    await invite.fill(a.id);
    await expect(dialog.getByLabel("Selected recipient").locator("img")).toBeVisible();
    await invite.fill("dsgn");
    await dialog.getByRole("option").filter({ hasText: "Design partner" }).click();
    await expect(dialog.getByLabel("Selected recipient").locator("img")).toBeVisible();
    await dialog.getByRole("button", { name: "Share with group" }).click();
    await expect(dialog.getByRole("button", { name: "Remove Design" })).toBeVisible();
  } finally {
    await context.close();
  }
});
