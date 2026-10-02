// @ts-check
// scripts/deploy/seal-check.mjs, the check both deploy verifiers share: a sealed folder is exactly what its signed manifest lists plus the
// stamped service worker. A stray file, a symlink, an edited or foreign service worker, an unsealed or misnamed build folder all fail.
// Throwaway keys only; the pinned-key rule is verify-*-out's own and is tested in verify-wink-out.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildWinkOut } from "../build-wink-out.mjs";
import { buildAppOut } from "../build-app-out.mjs";
import { checkSealed, expectedSw } from "./seal-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "seal-check-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const pubOf = r => new Uint8Array(Buffer.from(r.pub, "base64url"));
const fakeDist = d => {
  fs.mkdirSync(path.join(d, "_expo", "static", "js"), { recursive: true });
  fs.writeFileSync(path.join(d, "index.html"), '<!doctype html><html><body><script src="/_expo/static/js/entry-abc.js" defer></script></body></html>');
  fs.writeFileSync(path.join(d, "_expo", "static", "js", "entry-abc.js"), "console.log('app');");
};

test("seal-check: a camera-page build passes, and a stray file, a symlink, an edited or foreign sw.js each fail", async t => {
  const out = path.join(tmp(t), "wink-out");
  const r = await buildWinkOut({ release: "0.2.0", out, throwaway: true });
  const pub = pubOf(r);
  assert.ok((await checkSealed(out, pub, ROOT, { loader: true })).length > 10, "a good build passes");
  assert.equal(fs.readFileSync(path.join(out, "sw.js"), "utf8"), expectedSw(ROOT, pub), "sw.js is relay/app/sw.js stamped with the key");
  fs.writeFileSync(path.join(out, "extra.js"), "x");
  await assert.rejects(checkSealed(out, pub, ROOT, { loader: true }), /does not list: extra\.js/);
  fs.rmSync(path.join(out, "extra.js"));
  fs.symlinkSync("/etc/hosts", path.join(out, "link"));
  await assert.rejects(checkSealed(out, pub, ROOT, { loader: true }), /not a regular file/);
  fs.rmSync(path.join(out, "link"));
  fs.appendFileSync(path.join(out, "sw.js"), "\n// edited");
  await assert.rejects(checkSealed(out, pub, ROOT, { loader: true }), /sw\.js is not relay\/app\/sw\.js/);
  fs.writeFileSync(path.join(out, "sw.js"), expectedSw(ROOT, new Uint8Array(32)));
  await assert.rejects(checkSealed(out, pub, ROOT, { loader: true }), /stamped with the pinned release key/, "stamped with another key");
  fs.rmSync(path.join(out, "sw.js"));
  await assert.rejects(checkSealed(out, pub, ROOT, { loader: true }), /no sw\.js/);
});

test("seal-check: the app's loader and builds pass, and a stray file in a build, or a v/ entry that is not a sealed build, fail", async t => {
  const dist = path.join(tmp(t), "dist"); fs.mkdirSync(dist); fakeDist(dist);
  const out = path.join(tmp(t), "app-out");
  const r = await buildAppOut({ dist, release: "0.2.0", out, throwaway: true });
  const pub = pubOf(r);
  assert.ok((await checkSealed(out, pub, ROOT, { loader: true })).length > 10, "the loader passes with its v/ tree beside it");
  const [build] = r.folders.filter(f => f !== out);
  assert.ok((await checkSealed(build, pub, ROOT, { loader: false })).length > 10, "a build folder passes");
  fs.writeFileSync(path.join(build, "sw.js"), "self.x=1");
  await assert.rejects(checkSealed(build, pub, ROOT, { loader: false }), /does not list: sw\.js/, "a build folder carries no service worker of its own");
  fs.rmSync(path.join(build, "sw.js"));
  fs.writeFileSync(path.join(out, "stray.html"), "x");
  await assert.rejects(checkSealed(out, pub, ROOT, { loader: true }), /does not list: stray\.html/);
});

test("verify-app-out: a stray file under v/ or an unsealed build folder stops the deploy (the pinned key is checked first, so these are read from the message)", async t => {
  const dist = path.join(tmp(t), "dist"); fs.mkdirSync(dist); fakeDist(dist);
  const out = path.join(tmp(t), "app-out");
  await buildAppOut({ dist, release: "0.2.0", out, throwaway: true });
  const run = () => spawnSync(process.execPath, [path.join(ROOT, "scripts/deploy/verify-app-out.mjs"), out], { encoding: "utf8" });
  fs.writeFileSync(path.join(out, "v", "note.txt"), "x");
  assert.match(run().stderr, /FAILED v: not a sealed build folder: note\.txt/);
  fs.rmSync(path.join(out, "v", "note.txt"));
  fs.mkdirSync(path.join(out, "v", "a".repeat(40)));
  assert.match(run().stderr, /no manifest|FAILED/, "an unsealed 40-hex folder is refused");
});
