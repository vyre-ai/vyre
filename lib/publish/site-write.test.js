// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSiteFiles, volumeFill } from "./site-write.js";

const scratch = (/** @type {any} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "sitew-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const tree = (/** @type {string} */ root, rel = "") => fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap(e => e.isDirectory() ? [rel + e.name + "/", ...tree(root, rel + e.name + "/")] : [rel + e.name]);

test("regular files are written into a fresh folder, read-only, with their folders", t => {
  const parent = scratch(t);
  const root = writeSiteFiles(parent, [{ path: "index.html", content: "<h1>x</h1>" }, { path: "assets/app.js", content: new Uint8Array([1, 2, 3]) }, { path: ".well-known/security.txt", content: "c" }]);
  assert.ok(root.startsWith(parent + path.sep));
  assert.deepEqual(tree(root).sort(), [".well-known/", ".well-known/security.txt", "assets/", "assets/app.js", "index.html"]);
  assert.equal(fs.readFileSync(path.join(root, "index.html"), "utf8"), "<h1>x</h1>");
  assert.equal(fs.statSync(path.join(root, "index.html")).mode & 0o777, 0o444 & ~process.umask());
  assert.equal(tree(root).every(n => !fs.lstatSync(path.join(root, n)).isSymbolicLink()), true);
});

test("a hand-off with a symlink to /etc/passwd or to .env, or a path that climbs out, writes nothing", t => {
  const parent = scratch(t);
  for (const evil of [{ path: "p", type: "symlink", target: "/etc/passwd", content: "" }, { path: "e", symlink: ".env", content: "" }, { path: "../escape", content: "x" }, { path: "a/../../escape", content: "x" }, { path: "/tmp/abs", content: "x" }]) {
    assert.throws(() => writeSiteFiles(parent, [{ path: "index.html", content: "x" }, /** @type {any} */ (evil)]), (/** @type {any} */ e) => e.code === "bad_output", JSON.stringify(evil));
    assert.deepEqual(fs.readdirSync(parent), [], "nothing was written, not even a folder");
  }
  assert.equal(fs.existsSync(path.join(path.dirname(parent), "escape")), false);
});

test("a file and a folder of the same name, and case or Unicode twins, are refused and leave nothing", t => {
  const parent = scratch(t);
  for (const files of [[{ path: "a", content: "x" }, { path: "a/b", content: "y" }], [{ path: "a/b", content: "y" }, { path: "a", content: "x" }], [{ path: "x.html", content: "1" }, { path: "X.HTML", content: "2" }], [{ path: "caf\u00e9.html", content: "1" }, { path: "cafe\u0301.html", content: "2" }]]) {
    assert.throws(() => writeSiteFiles(parent, files), (/** @type {any} */ e) => e.code === "bad_output", JSON.stringify(files));
    assert.deepEqual(fs.readdirSync(parent), []);
  }
});

test("a link planted where the writer would write stops it (O_NOFOLLOW, O_EXCL) and the folder is removed", t => {
  const parent = scratch(t);
  const real = fs.mkdtempSync(path.join(parent, "x-"));
  // Simulate a racing planter: the second file's name is already a link when the writer reaches it.
  const orig = fs.openSync;
  /** @type {any} */ (fs).openSync = (/** @type {string} */ p, /** @type {number} */ flags, /** @type {number} */ mode) => { if (String(p).endsWith("b.txt")) fs.symlinkSync("/etc/passwd", String(p)); return orig(p, flags, mode); };
  try {
    assert.throws(() => writeSiteFiles(parent, [{ path: "a.txt", content: "1" }, { path: "b.txt", content: "2" }]), (/** @type {any} */ e) => e.code === "EEXIST" || e.code === "ELOOP");
  } finally { /** @type {any} */ (fs).openSync = orig; }
  assert.deepEqual(fs.readdirSync(parent).filter(n => n.startsWith("site-")), []);
  void real;
});

test("the volume fill is a no-network container with only the capabilities it needs and the folder read-only", () => {
  const a = volumeFill("/tmp/vyre-publish-x/site-abc", "vyre-publish-spc_abcdefghijkl_site-0123456789abcdef");
  assert.deepEqual(a.slice(0, 8), ["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN"]);
  assert.ok(a.includes("/tmp/vyre-publish-x/site-abc:/in:ro") && a.includes("vyre-publish-spc_abcdefghijkl_site-0123456789abcdef:/srv"));
  assert.ok(!a.includes("--privileged") && !a.some(x => x === "-p"));
  for (const bad of ["rel/dir", "/tmp/a:b", "/tmp/a,b", "/tmp/a\nb"]) assert.throws(() => volumeFill(bad, "vol"), (/** @type {any} */ e) => e.code === "bad_input");
  for (const bad of ["../vol", "vol:/etc", "Vol", "-x", ""]) assert.throws(() => volumeFill("/tmp/ok", bad), (/** @type {any} */ e) => e.code === "bad_input");
});
