// @ts-check
// vyre.run v2 (scripts/gen-site.mjs): every page has one title, one description, a canonical URL and an Open Graph card that exists;
// the structured data parses; every internal link and asset resolves to a file; the sitemap lists exactly the pages; no em dash or
// section sign reaches a reader; the page is within the size budget. The served installers and the setup page are not generated here.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const PAGES = ["", "mac", "windows", "linux", "phone", "direction", "start", "privacy"];
const read = (p) => fs.readFileSync(path.join(SITE, p), "utf8");
const pageFile = (slug) => (slug ? `${slug}/index.html` : "index.html");
const BANNED = /[—§]/;

/** @param {string} href */
function exists(href) {
  const clean = href.split("#")[0].split("?")[0];
  if (!clean || clean === "/") return true;
  const p = path.join(SITE, clean);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return true;
  return fs.existsSync(path.join(p, "index.html"));
}
// Served by the build (scripts/build-site.sh) or a redirect, not committed: the install lines and the box files.
const BUILT = /^\/(i|w|install\.sh|box(\/.*)?|download\/mac|setup\/tokens\.css)$/;

for (const slug of PAGES) {
  test(`site v2: /${slug} metadata, structured data, links and words`, () => {
    const html = read(pageFile(slug));
    assert.equal((html.match(/<title>/g) || []).length, 1);
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, "exactly one h1");
    const desc = /<meta name="description" content="([^"]+)"/.exec(html);
    assert.ok(desc && desc[1].length >= 70 && desc[1].length <= 200, `description length ${desc && desc[1].length}`);
    const canon = /<link rel="canonical" href="([^"]+)"/.exec(html);
    assert.equal(canon && canon[1], `https://vyre.run/${slug ? slug + "/" : ""}`);
    const og = /<meta property="og:image" content="https:\/\/vyre\.run(\/og\/[^"]+)"/.exec(html);
    assert.ok(og && exists(og[1]), "og:image points at a file in site/og");
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html);
    assert.ok(ld, "has JSON-LD");
    const graph = JSON.parse(ld[1])["@graph"];
    assert.ok(graph.some((n) => n["@type"] === "Organization"));
    if (slug === "") { assert.ok(graph.some((n) => n["@type"] === "SoftwareApplication")); assert.ok(graph.some((n) => n["@type"] === "FAQPage")); }
    for (const l of html.matchAll(/(?:href|src)="(\/[^"#?]*)[^"]*"/g)) {
      if (BUILT.test(l[1])) continue;
      assert.ok(exists(l[1]), `${slug || "home"}: ${l[1]} does not resolve`);
    }
    const text = html.replace(/<script.*?<\/script>|<style.*?<\/style>/gs, "");
    assert.ok(!BANNED.test(text), "no em dash or section sign");
    assert.ok(Buffer.byteLength(html) < 120 * 1024, "the page is under 120 KB");
    for (const m of text.matchAll(/<img\b[^>]*>/g)) assert.match(m[0], /\balt="/, "images have alt text");
  });
}

test("site v2: sitemap lists every page and nothing else; robots points at it", () => {
  const sm = read("sitemap.xml");
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
  assert.deepEqual(locs, PAGES.map((s) => `https://vyre.run/${s ? s + "/" : ""}`).sort());
  assert.match(read("robots.txt"), /Sitemap: https:\/\/vyre\.run\/sitemap\.xml/);
});

test("site v2: llms.txt, llms-full.txt, agents.md and the agent file exist and agree on the facts", () => {
  for (const f of ["llms.txt", "llms-full.txt", "agents.md"]) assert.ok(read(f).length > 500, f);
  for (const f of ["llms.txt", "llms-full.txt", "agents.md"]) assert.ok(!BANNED.test(read(f)), f);
  const agent = JSON.parse(read(".well-known/agent.json"));
  assert.equal(agent.license, "Apache-2.0");
  assert.match(read("llms-full.txt"), /Network: built in/);
  assert.ok(!/Tailscale/i.test(read("llms-full.txt")), "no other VPN product in the full text");
  assert.match(read("agents.md"), /Do not run the install line/);
});

test("site v2: the pages leave the installers and the setup page alone", () => {
  for (const f of ["setup/index.html", "setup/page.js", "setup/reserve.js"]) assert.ok(fs.existsSync(path.join(SITE, f)), f);
  const gen = fs.readFileSync(path.join(SITE, "..", "scripts", "gen-site.mjs"), "utf8");
  assert.ok(!/writeFileSync\(join\(site, ['"`](setup|box|install|i|w)\b/.test(gen), "the generator never writes the installers or setup");
});
