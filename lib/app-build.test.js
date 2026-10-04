// @ts-check
// The web app's files are covered by the release signature (MW-5): a packaged daemon serves a file of /app/ only when it is on the signed list and its bytes match.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../test/scratch.mjs";
import { appGate, buildAppList, readAppBuild } from "./app-build.js";
import { SUMS_PREFIX } from "./release-sig.js";
import { serveApp } from "../core/daemon/app.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (/** @type {string | Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const KEY = crypto.generateKeyPairSync("ed25519");
const PUB = KEY.publicKey.export({ type: "spki", format: "der" }).toString("base64");

/** A package root with an exported build, its appbuild.json and a SHA256SUMS signed by KEY (or by another key). */
function pkg(/** @type {import("node:test").TestContext} */ t, { sign = KEY, list = true } = {}) {
  const root = fs.mkdtempSync(path.join(SCRATCH, "app-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, "apps", "app", "dist");
  fs.mkdirSync(path.join(dist, "_expo", "static", "js"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<html>app</html>");
  fs.writeFileSync(path.join(dist, "_expo", "static", "js", "entry-1.js"), "console.log(1)");
  if (list) {
    fs.writeFileSync(path.join(root, "appbuild.json"), buildAppList(dist, "0.3.0", 3000000));
    const sums = Buffer.from(`${sha(fs.readFileSync(path.join(root, "appbuild.json")))}  appbuild.json\n`);
    fs.writeFileSync(path.join(root, "SHA256SUMS"), sums);
    fs.writeFileSync(path.join(root, "SHA256SUMS.sig"), crypto.sign(null, Buffer.concat([SUMS_PREFIX, sums]), sign.privateKey).toString("base64") + "\n");
  }
  return { root, dist };
}
const res = () => { const r = /** @type {any} */ ({ status: 0, body: "" }); r.writeHead = (/** @type {number} */ s) => { r.status = s; }; r.end = (/** @type {any} */ b) => { r.body = String(b ?? ""); }; return r; };
const get = (/** @type {any} */ p, /** @type {string} */ url, /** @type {boolean} */ packaged = true) => { const r = res(); serveApp(r, url, { dir: p.dist, gate: appGate({ root: p.root, packaged, key: PUB }) }); return r; };

test("a listed file is served; a changed file, an added file and a missing list are refused", t => {
  const p = pkg(t);
  assert.equal(get(p, "/app/").status, 200);
  assert.equal(get(p, "/app/_expo/static/js/entry-1.js").status, 200);
  fs.appendFileSync(path.join(p.dist, "_expo", "static", "js", "entry-1.js"), "\n//changed");
  const changed = get(p, "/app/_expo/static/js/entry-1.js");
  assert.equal(changed.status, 503); assert.match(changed.body, /app_build_changed/);
  fs.writeFileSync(path.join(p.dist, "evil.js"), "alert(1)");
  const added = get(p, "/app/evil.js");
  assert.equal(added.status, 503); assert.match(added.body, /app_build_unlisted/);
  fs.writeFileSync(path.join(p.dist, "index.html"), "<html>changed</html>");
  assert.equal(get(p, "/app/").status, 503, "the shell itself is checked too, including as the single-page fallback");
  const none = pkg(t, { list: false });
  const r = get(none, "/app/"); assert.equal(r.status, 503); assert.match(r.body, /app_build_unsigned/);
});

test("a list not signed by the release key, or not the file SHA256SUMS lists, is no list", t => {
  const other = crypto.generateKeyPairSync("ed25519");
  const p = pkg(t, { sign: other });
  const r = get(p, "/app/"); assert.equal(r.status, 503); assert.match(r.body, /not signed by Vyre's release key/);
  const q = pkg(t);
  fs.writeFileSync(path.join(q.root, "appbuild.json"), buildAppList(q.dist, "0.3.0").replace("0.3.0", "9.9.9"));
  assert.match(String(/** @type {any} */ (readAppBuild(q.root, PUB)).why), /not the file the signed SHA256SUMS lists/);
  assert.equal(get(q, "/app/").status, 503);
});

test("a development build (not packaged) is not gated, so a checkout still serves what it built", t => {
  const p = pkg(t, { list: false });
  assert.equal(get(p, "/app/", false).status, 200);
});

test("scripts/appbuild-manifest.mjs lists every file of the unpacked build, and the list verifies against the gate", t => {
  const p = pkg(t, { list: false });
  const out = path.join(p.root, "out.json");
  const r = spawnSync("node", [path.join(REPO, "scripts/appbuild-manifest.mjs"), p.root, "--release", "0.3.0", "--counter", "3000000", "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(j.files).sort(), ["_expo/static/js/entry-1.js", "index.html"]);
  assert.equal(j.release, "0.3.0"); assert.equal(j.version, "0.3.0"); assert.equal(j.counter, 3000000);
  assert.match(j.tree, /^[0-9a-f]{64}$/);
  assert.equal(j.files["index.html"], sha("<html>app</html>"));
});
