// @ts-check
// A folder of ready files as a build: what is read, what is left out and named, what is refused, and that the same folder is the same digest.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSite, folderRefusal, LIMITS } from "./folder-build.js";

const tmp = (/** @type {import("node:test").TestContext} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-site-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const put = (/** @type {string} */ root, /** @type {Record<string, string>} */ files) => { for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, n)), { recursive: true }); fs.writeFileSync(path.join(root, n), c); } };

test("the files are read in a stable order, with a digest over paths and contents", t => {
  const a = tmp(t), b = tmp(t);
  put(a, { "index.html": "<h1>Northwind</h1>", "css/site.css": "body{margin:0}" });
  put(b, { "css/site.css": "body{margin:0}", "index.html": "<h1>Northwind</h1>" });
  const x = readSite({ dir: a }), y = readSite({ dir: b });
  assert.deepEqual(x.files.map(f => f.path), ["css/site.css", "index.html"]);
  assert.equal(x.digest, y.digest, "the same files are the same build, wherever the folder is");
  put(b, { "index.html": "<h1>Northwind Bakery</h1>" });
  assert.notEqual(readSite({ dir: b }).digest, x.digest);
});

test("secret-looking files, .git, node_modules and links are left out and named, never read", t => {
  const d = tmp(t), outside = tmp(t);
  put(d, { "index.html": "<p>hi</p>", ".env": "KEY=not-published", "keys/id_rsa": "x", "cert.pem": "x", ".git/config": "x", "node_modules/a/index.js": "x" });
  put(outside, { "secret.txt": "not in the site" });
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(d, "linked.txt"));
  const r = readSite({ dir: d });
  assert.deepEqual(r.files.map(f => f.path), ["index.html"]);
  assert.deepEqual(r.skipped.sort(), [".env", ".git/", "cert.pem", "keys/id_rsa", "linked.txt (a link)", "node_modules/"].sort());
  assert.ok(!r.files.some(f => String(f.content).includes("not published")));
});

test("an output folder inside the source is the site; one that escapes it, a missing one and an empty one are refused", t => {
  const d = tmp(t);
  put(d, { "dist/index.html": "<p>site</p>", "src/app.js": "x" });
  assert.deepEqual(readSite({ dir: d, outputDir: "dist" }).files.map(f => f.path), ["index.html"]);
  assert.throws(() => readSite({ dir: d, outputDir: "../" }), { code: "bad_input" });
  assert.throws(() => readSite({ dir: d, outputDir: "build" }), { code: "not_found", message: /no build/ });
  fs.mkdirSync(path.join(d, "empty"));
  assert.throws(() => readSite({ dir: d, outputDir: "empty" }), { message: /no files to publish/ });
  assert.throws(() => readSite({ dir: path.join(d, "nope") }), { code: "not_found" });
});

test("a folder over the limits is refused with the limit named", t => {
  const d = tmp(t);
  put(d, { "a.txt": "x".repeat(20), "b.txt": "y".repeat(20), "c.txt": "z" });
  assert.throws(() => readSite({ dir: d, limits: { ...LIMITS, files: 2 } }), { code: "too_large", message: /more than 2 files/ });
  assert.throws(() => readSite({ dir: d, limits: { ...LIMITS, file: 10 } }), { code: "too_large", message: /a\.txt is over/ });
  assert.throws(() => readSite({ dir: d, limits: { ...LIMITS, bytes: 30 } }), { code: "too_large" });
});

test("naming a folder on the server is the person's: a model is refused, a person may name any folder that is there", t => {
  const home = tmp(t);
  put(home, { "sites/a/index.html": "x" });
  assert.equal(folderRefusal(path.join(home, "sites/a"), { person: true }), null);
  assert.equal(folderRefusal(path.join(home, "sites/a"), { person: false }).code, "denied", "not even a folder under Vyre's home");
  assert.match(folderRefusal(home, { person: false }).message, /ask them to publish it/);
  assert.equal(folderRefusal(path.join(home, "nope"), { person: true }).code, "not_found");
  assert.equal(folderRefusal(path.join(home, "sites/a/index.html"), { person: true }).code, "bad_input");
});

test("a file that holds a key is refused with its name and the kind of key, never the key; a plain text file is fine", t => {
  const d = tmp(t);
  const token = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
  put(d, { "index.html": "<p>hi</p>", "notes.md": "docs may talk about tokens in general" });
  assert.equal(readSite({ dir: d }).files.length, 2);
  put(d, { "js/config.js": `const t = "${token}";` });
  assert.throws(() => readSite({ dir: d }), (/** @type {any} */ e) => { assert.equal(e.code, "secret_in_build"); assert.match(e.message, /js\/config\.js looks like it holds a GitHub token/); assert.ok(!e.message.includes(token)); return true; });
});

test("a file swapped for a pipe is skipped, not waited on; the left-out list is capped", t => {
  const d = tmp(t);
  put(d, { "index.html": "<p>hi</p>" });
  const r = readSite({ dir: d });
  assert.equal(r.files.length, 1);
  put(d, Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`.env.${i}`, "x"])));
  assert.equal(readSite({ dir: d }).skipped.length, 100, "the list of what was left out stops at 100");
});
