// @ts-check
// No other VPN product in Vyre (DESIGN-wink 4: "No Tailscale", the user, 4 Oct 2026). The built-in network is Wink; nothing the person sees, installs or signs in to is another
// product. This walks the tree for the product's words (tailscale, ts.net, taildrop, taildrive, tsnet) and fails on a file that is neither
//   - PERMANENT: the Wink engine (it is built from the open-source client core and must name it), history and decisions (ADRs, work logs, the changelog, docs/design),
//     the secret redactors and address refusals that exist to catch or refuse that product's strings, a reserved name, a word list, and this test; or
//   - on the RATCHET list: files that still mention it and are owned by a later step (team/0.3/TAILSCALE-removal.md). The ratchet only shrinks: a file not on it that gains the word
//     fails, and a file on it that no longer has the word fails too, so the list is cleaned as the work lands.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORD = /tailscale|\bts\.net\b|taildrop|taildrive|tsnet/i;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-ios", "dist-web", "ssh-none", "reference"]);
const TEXT = /\.(js|mjs|cjs|ts|tsx|json|md|html|css|sh|yml|yaml|go|mod|txt|swift|kt|rs|toml|plist|service|socket)$|^(Dockerfile|vyre)$/;

const PERMANENT = [
  /^wink\/forwarder\//, /^core\/wink\/node\//, /^core\/wink\/control\//, /^scripts\/spike-wink\//,
  /^docs\/(adr|design|work|proposals|releases)\//, /^docs\/(nav|index)\.json$/, /^CHANGELOG\.md$/, /^site\/CHANGELOG\.md$/, /^release\/notes\//,
  /^lib\/sanitize\.js$/, /^lib\/credential-shapes\.js$/, /^test\/allowed-dependencies\.json$/, /^local\/hands-chrome-mac\/extension\/shared\/sk\/credential-shapes\.js$/, /^apps\/app\/src\/store-core\/credential-shapes\.js$/,
  /^lib\/api-endpoint\.js$/, /^core\/mcp\/hub\.js$/, /^core\/vault\/api-request\.js$/, /^core\/spawner\/wall\.js$/, /^packages\/module-sdk\//,
  /^core\/names\/rules\.js$/, /^core\/memory\/lexicon\.js$/, /^core\/network\/other-vpn\.js$/, /^test\/no-tailscale\.test\.js$/, /^NOTICE$/,
  /^scripts\/lib\/hygiene\.js$/, /^scripts\/team\/ratchets\.mjs$/,
];

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(rel, out);
    else if (TEXT.test(e.name) || e.name === "vyre") out.push(rel);
  }
  return out;
}

test("no other VPN product: a file that names it is permanent, or on the shrinking ratchet", () => {
  const ratchet = new Set(JSON.parse(fs.readFileSync(path.join(REPO, "test", "no-tailscale.ratchet.json"), "utf8")).files);
  const hits = [];
  for (const rel of walk("", [])) {
    if (PERMANENT.some(r => r.test(rel))) continue;
    let text;
    try { text = fs.readFileSync(path.join(REPO, rel), "utf8"); } catch { continue; }
    if (text.length < 8_000_000 && WORD.test(text)) hits.push(rel);
  }
  const hit = new Set(hits);
  const fresh = hits.filter(f => !ratchet.has(f));
  const cleaned = [...ratchet].filter(f => !hit.has(f) && fs.existsSync(path.join(REPO, f)));
  assert.deepEqual(fresh, [], `these files name another VPN product and are not on test/no-tailscale.ratchet.json (write about the built-in network instead):\n${fresh.join("\n")}`);
  assert.deepEqual(cleaned, [], `these files are clean now: remove them from test/no-tailscale.ratchet.json:\n${cleaned.join("\n")}`);
});

test("no other VPN product: nothing the person sees (the setup page, the site, the README, the CLI's own words, the onboarding module) names it", () => {
  for (const rel of ["README.md", "site/setup/reserve.js", "site/setup/page.js", "scripts/gen-site.mjs", "core/onboard/index.js", "core/network/index.js", "core/network/wink.js",
    "core/names/index.js", "core/names/service.js", "core/cli/commands/phone.js", "core/cli/commands/box.js", "core/cli/commands/up.js", "core/cli/ssh.js", "core/hooks/index.js", "core/link/health.js"]) {
    assert.ok(!WORD.test(fs.readFileSync(path.join(REPO, rel), "utf8")), `${rel} names another VPN product`);
  }
});
