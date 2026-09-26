// @ts-check
// The guard on its own: path rules, the deny list at any depth, symlinks, and what a listing
// hides. Everything runs in a temp folder.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DENY, checkRel, resolveIn, deniedSegments, hidden, checkName } from "./guard.js";
import { LocalTree } from "./providers/box.js";

/**
 * One example per DENY entry. Link's files module keeps the same list; if a DENY entry is added
 * without an example here, the first test fails.
 */
export const DENIED_EXAMPLES = {
  ".vyre": ".vyre", ".claude": ".claude", ".claude.json": ".claude.json", ".ssh": ".ssh", ".gnupg": ".gnupg", ".aws": ".aws",
  ".docker": ".docker", ".kube": ".kube", ".config/gcloud": ".config/gcloud", ".git-credentials": ".git-credentials",
  ".netrc": ".netrc", ".npmrc": ".npmrc", ".pypirc": ".pypirc", ".env": ".env", ".env.*": ".env.local", "*.pem": "server.pem",
  "*.key": "tls.key", "*.p12": "cert.p12", "*.pfx": "cert.pfx", "*.kdbx": "vault.kdbx", "*.keychain*": "login.keychain-db",
  "id_*": "id_ed25519", "credentials.json": "credentials.json", "service-account*.json": "service-account-prod.json", Cookies: "Cookies",
  "Login Data": "Login Data", "Login Data For Account": "Login Data For Account", "Web Data": "Web Data", secrets: "secrets",
  ".vnc": ".vnc",
};

const ALLOWED = ["notes.txt", "config.json", ".config/app.json", "environment.md", "keys.txt", "tls.key.txt", "my-secrets-plan.md", ".envrc.example"];

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("guard: every DENY entry has an example, and each is refused at the top and at depth", () => {
  assert.deepEqual(Object.keys(DENIED_EXAMPLES).sort(), [...DENY].sort());
  for (const ex of Object.values(DENIED_EXAMPLES)) {
    assert.throws(() => checkRel(ex), /private place/, ex);
    assert.throws(() => checkRel(`projects/app/${ex}`), /private place/, `projects/app/${ex}`);
    assert.throws(() => checkRel(`${ex}/inside`), /private place/, `${ex}/inside`);
  }
  assert.throws(() => checkRel("home/.SSH/known_hosts"), /private place/, "case folding");
  assert.throws(() => checkRel("a/secrets/b.txt"), /private place/);
  for (const ok of ALLOWED) assert.deepEqual(checkRel(ok), ok.split("/"), ok);
});

test("guard: absolute, NUL, .. and home paths are refused, not cleaned", () => {
  for (const bad of ["/etc/passwd", "\\\\server\\share", "C:\\Windows", "~/x", "~"]) assert.throws(() => checkRel(bad), /absolute/, bad);
  assert.throws(() => checkRel("a\0b"), /NUL/);
  for (const bad of ["..", "../x", "a/../../x", "a/../b", "a\\..\\b", "./.."]) assert.throws(() => checkRel(bad), /climbs out/, bad);
  assert.deepEqual(checkRel(""), []);
  assert.deepEqual(checkRel("./a//b/"), ["a", "b"]);
  assert.throws(() => checkRel(/** @type {any} */ (5)), /string/);
  assert.throws(() => checkName("a/b"), /not a file name/);
  assert.throws(() => checkName(".vyre-upload-x"), /private name/);
  assert.throws(() => checkName("id_rsa"), /private name/);
  assert.equal(checkName("report.pdf"), "report.pdf");
});

test("guard: symlinks resolve inside the root or not at all", t => {
  const dir = temp(t);
  const root = path.join(dir, "root"), outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, ".ssh"));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "loot.txt"), "x");
  fs.writeFileSync(path.join(root, "docs", "a.txt"), "a");
  fs.symlinkSync(outside, path.join(root, "out"));
  fs.symlinkSync(path.join(outside, "loot.txt"), path.join(root, "loot.txt"));
  fs.symlinkSync(path.join(root, "docs"), path.join(root, "docs-link"));
  fs.symlinkSync(path.join(root, ".ssh"), path.join(root, "keys-dir"));
  assert.throws(() => resolveIn(root, "out/loot.txt"), /outside its root/);
  assert.throws(() => resolveIn(root, "loot.txt"), /outside its root/);
  assert.throws(() => resolveIn(root, "out/new.txt", { create: true }), /outside its root/, "a new file through an escaping folder link");
  assert.throws(() => resolveIn(root, "keys-dir"), /private place/, "a link inside the root onto a denied name");
  assert.equal(resolveIn(root, "docs-link/a.txt").real, fs.realpathSync(path.join(root, "docs", "a.txt")));
  // An existing link at a write's destination is resolved like a read.
  assert.throws(() => resolveIn(root, "loot.txt", { create: true }), /outside its root/);
  assert.throws(() => resolveIn(root, "missing/x.txt", { create: true }), /does not exist/);
  assert.throws(() => resolveIn(root, "", { create: true }), /root cannot/);
});

test("guard: a listing hides denied names and Glass's own files, and shows links honestly", async t => {
  const dir = temp(t);
  const root = path.join(dir, "root"), outside = path.join(dir, "outside");
  fs.mkdirSync(root); fs.mkdirSync(outside);
  for (const ex of Object.values(DENIED_EXAMPLES)) {
    const p = path.join(root, ex);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) fs.writeFileSync(p, "hidden");
  }
  for (const name of ["notes.txt", "tls.key.txt", ".vyre-trash", ".vyre-upload-abc"]) fs.writeFileSync(path.join(root, name), "x");
  fs.mkdirSync(path.join(root, "sub"));
  fs.symlinkSync(outside, path.join(root, "away"));
  fs.symlinkSync(path.join(root, "sub"), path.join(root, "here"));
  const tree = new LocalTree(root);
  const { entries } = await tree.list("");
  const names = entries.map(e => e.name).sort();
  assert.deepEqual(names, [".config", "away", "here", "notes.txt", "sub", "tls.key.txt"]);
  assert.deepEqual((await tree.list(".config")).entries, [], ".config/gcloud is hidden inside .config");
  const away = entries.find(e => e.name === "away"), here = entries.find(e => e.name === "here");
  assert.deepEqual([away?.kind, away?.to], ["link", null]);
  assert.deepEqual([here?.kind, here?.to], ["link", "dir"]);
  assert.equal(hidden("Cookies", ["Default"]), true);
  assert.equal(deniedSegments([".docker", "config.json"]), true);
  assert.equal(deniedSegments(["config.json"]), false);
});
