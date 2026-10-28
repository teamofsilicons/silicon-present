/** The public files built from lib/app.config.ts: robots.txt, the sitemap and the llms.txt stub. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { llmsTxt, robotsTxt, sitemapXml } from "../lib/agent/files";
import { markSvg } from "../lib/brand-svg";

const ORIGIN = "https://present.example";

test("robots.txt opens the public pages and keeps the workspace, sign-in and the proxy out", () => {
  const text = robotsTxt(ORIGIN);
  assert.match(text, /^# https:\/\/present\.example: Present\./);
  for (const line of ["User-agent: ClaudeBot", "User-agent: *", "Allow: /", "Allow: /llms.txt", "Disallow: /api/", "Disallow: /auth/", "Disallow: /sign-in", "Disallow: /decks", "Disallow: /transfers", "Disallow: /trash", "Disallow: /p/", "Disallow: /sandbox/", `Sitemap: ${ORIGIN}/sitemap.xml`]) {
    assert.ok(text.split("\n").includes(line), line);
  }
});

test("the sitemap lists the public pages with their date", () => {
  const xml = sitemapXml(ORIGIN, "2026-10-10");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes(`<url><loc>${ORIGIN}/</loc><lastmod>2026-10-10</lastmod></url>`));
  assert.ok(xml.includes(`<loc>${ORIGIN}/llms.txt</loc>`));
});

test("llms.txt says what the app is, how a Silicon installs it and signs in, and where the docs are", () => {
  const text = llmsTxt(ORIGIN);
  assert.match(text, /^# Present\n\n> Slides that Carbons and Silicons make, present and comment on together\.\n/);
  assert.ok(text.includes("`silicon-apps install present`"));
  assert.ok(text.includes("`silicon-accounts login --app present -q | present login --slt-stdin`"));
  assert.ok(text.includes("- [Docs](https://developers.teamofsilicons.com/docs)"));
  for (const word of ["AI agent", "human", "user account", "organization", " org ", "Honeycomb", "IAM"]) assert.ok(!text.includes(word), `never "${word}"`);
});

test("the mark retains the supplied presentation artwork on its dark square", () => {
  const svg = markSvg();
  assert.ok(svg.includes('viewBox="0 0 200 200"'));
  assert.ok(svg.includes('<rect width="200" height="200" fill="#181818"/>'));
  assert.ok(svg.includes('stroke="#EDE8E0"'));
  assert.ok(svg.includes('<path d="M79.4316 139.2L98.9316 119.7L118.432 139.2"/>'));
});
