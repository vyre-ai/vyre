// @ts-check
// scripts/cf-unmangle.mjs puts a Cloudflare-rewritten page back (the email obfuscation and its decode script), so assemble-site.sh --check can still compare a served HTML page byte for byte.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (/** @type {string} */ input) => spawnSync(process.execPath, [path.join(REPO, "scripts/cf-unmangle.mjs")], { input, encoding: "utf8" }).stdout;
/** Cloudflare's own encoding: a random key byte, then each character XOR-ed with it. */
const cf = (/** @type {string} */ email, key = 0x5d) => [key, ...[...email].map(c => c.charCodeAt(0) ^ key)].map(n => n.toString(16).padStart(2, "0")).join("");

test("cf-unmangle: an obfuscated address and the decode script come back as the page was uploaded", () => {
  const original = '<p>for example <code>alex@192.0.2.10</code>). Mail <a href="mailto:hi@vyre.run">hi</a>.</p></body>';
  const served = `<p>for example <code><a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cf("alex@192.0.2.10")}">[email&#160;protected]</a></code>). Mail <a href="/cdn-cgi/l/email-protection#${cf("hi@vyre.run", 0x21)}">hi</a>.</p><script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script></body>`;
  assert.equal(run(served), original);
});

test("cf-unmangle: a page with nothing rewritten is returned unchanged, and a real difference is not hidden", () => {
  const page = "<html><body><p>docs</p></body></html>\n";
  assert.equal(run(page), page);
  assert.notEqual(run(page.replace("docs", "DOCS")), page);
});
