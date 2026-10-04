// @ts-check
import "../scripts/mac-test-guard.mjs";
// The module list rides inside shell.json (a 0.2.x server updated by its OLD updater receives only SHA256SUMS, its signature and shell.json): taken only from a shell.json whose signature chain
// verified, and nothing is taken from one that does not. The release key here is a throwaway.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../test/scratch.mjs";
import { deriveFromShell, releaseFile, placeFromShell } from "./release-shell.js";
import { readReleaseList } from "../kernel/modules/release-list.js";
import { watchForList } from "../core/daemon/release-watch.js";

const sha = (/** @type {string | Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const kp = crypto.generateKeyPairSync("ed25519");
const KEY = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const other = crypto.generateKeyPairSync("ed25519");
const MODULES = JSON.stringify({ v: 1, counter: 5, release: "1.0.0", modules: { a: { version: "0.1.0", tree: "a".repeat(64) } } }, null, 1) + "\n";
const APP = JSON.stringify({ v: 1, release: "1.0.0", base: "/app/", files: { "index.html": "b".repeat(64) } }, null, 1) + "\n";

/** A package root whose deck/release holds what an old updater publishes: SHA256SUMS, its signature and shell.json; nothing at the root. */
function box(/** @type {import("node:test").TestContext} */ t, { shellModules = MODULES, signWith = kp.privateKey, listShell = true, listModules = true } = {}) {
  const root = fs.mkdtempSync(path.join(SCRATCH, "rs-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rel = path.join(root, "deck", "release"); fs.mkdirSync(rel, { recursive: true });
  const shell = JSON.stringify({ v: 1, version: "1.0.0", files: [], modulesJson: shellModules, appbuildJson: APP });
  fs.writeFileSync(path.join(rel, "shell.json"), shell);
  const sums = [listShell ? `${sha(shell)}  shell.json` : "", listModules ? `${sha(MODULES)}  modules.json` : "", `${sha(APP)}  appbuild.json`].filter(Boolean).join("\n") + "\n";
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), sums);
  fs.writeFileSync(path.join(rel, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([Buffer.from("vyre-release-sums\n"), Buffer.from(sums)]), signWith).toString("base64") + "\n");
  return root;
}

test("the module list and the app record come out of a shell.json whose signature chain verifies, byte for byte", t => {
  const root = box(t);
  assert.equal(String(releaseFile(root, "modules.json", KEY)), MODULES);
  assert.equal(String(releaseFile(root, "appbuild.json", KEY)), APP);
  const r = readReleaseList(root, KEY);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("nothing is taken from a tampered shell.json, a signature by another key, or a list the signed sums do not name", t => {
  const tampered = box(t, { shellModules: MODULES.replace('"counter": 5', '"counter": 9') });
  assert.equal(releaseFile(tampered, "modules.json", KEY), null, "text that does not hash to the signed line");
  assert.equal(readReleaseList(tampered, KEY).ok, false);
  const wrongKey = box(t, { signWith: other.privateKey });
  assert.equal(releaseFile(wrongKey, "modules.json", KEY), null, "sums signed by another key");
  assert.equal(readReleaseList(wrongKey, KEY).ok, false);
  const unlistedShell = box(t, { listShell: false });
  assert.equal(releaseFile(unlistedShell, "modules.json", KEY), null, "shell.json is not the file the signed sums list");
  const unlistedModules = box(t, { listModules: false });
  assert.equal(releaseFile(unlistedModules, "modules.json", KEY), null, "modules.json has no signed line");
  const bare = fs.mkdtempSync(path.join(SCRATCH, "rs-")); t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.equal(releaseFile(bare, "modules.json", KEY), null, "nothing published at all");
  assert.equal(deriveFromShell({ sums: Buffer.from(""), sig: Buffer.from(""), shell: Buffer.from("{}") }, KEY).ok, false);
});

test("a file at the package root wins and is checked as before; place-release's helper writes only what is missing", t => {
  const root = box(t);
  const n = placeFromShell(root, KEY);
  assert.deepEqual(n.sort(), ["appbuild.json", "modules.json"]);
  assert.equal(fs.readFileSync(path.join(root, "modules.json"), "utf8"), MODULES);
  assert.deepEqual(placeFromShell(root, KEY), [], "nothing is overwritten");
  const bad = box(t, { signWith: other.privateKey });
  assert.deepEqual(placeFromShell(bad, KEY), []);
  assert.ok(!fs.existsSync(path.join(bad, "modules.json")), "a list that does not verify is never written");
});

test("a stale SHA256SUMS at the root (the previous release's, placed when the container started) does not hide the list the host published since", t => {
  const root = box(t);
  fs.writeFileSync(path.join(root, "SHA256SUMS"), `${"0".repeat(64)}  vyre.tgz\n`);
  fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), fs.readFileSync(path.join(root, "deck", "release", "SHA256SUMS.sig")));
  assert.equal(String(releaseFile(root, "modules.json", KEY)), MODULES);
});

test("the watch waits for a list that is not there yet, restarts once when it verifies, and says so when it never comes", async () => {
  let n = 0, found = 0;
  const w = watchForList({ read: () => (++n >= 3 ? { ok: true } : { ok: false, why: "there is no signed list of modules (modules.json)" }), onFound: () => { found++; }, pollMs: 5, waitMs: 1000 });
  assert.equal(w.state(), "waiting");
  await new Promise(r => setTimeout(r, 80));
  assert.equal(found, 1); assert.equal(w.state(), "found");
  const never = watchForList({ read: () => ({ ok: false, why: "there is no signed list of modules (modules.json)" }), onFound: () => { throw new Error("never"); }, pollMs: 5, waitMs: 40 });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(never.state(), "gave_up");
  // A list that is present but does not verify is a refusal, not an update in flight: no waiting.
  const bad = watchForList({ read: () => ({ ok: false, why: "SHA256SUMS is not signed by Vyre's release key" }), onFound: () => { throw new Error("never"); }, pollMs: 5, waitMs: 40 });
  assert.equal(bad.state(), null);
  // Already there: nothing to wait for.
  assert.equal(watchForList({ read: () => ({ ok: true }), onFound: () => {}, pollMs: 5 }).state(), null);
});
