// @ts-check
// scripts/build-app-out.mjs: the hosted app's release step, with a throwaway key (never the real one). It
// seals the loader and the app build, every folder verifies against the signing key, a tampered file or a
// wrong key fails, and a real-key run refuses a key that is not the pinned one.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAppOut } from "../scripts/build-app-out.mjs";
import { verify } from "../relay/app/release.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "app-out-")); }
function fakeDist() {
  const d = tmp();
  fs.mkdirSync(path.join(d, "_expo", "static", "js"), { recursive: true });
  fs.writeFileSync(path.join(d, "index.html"), '<!doctype html><html><body><script src="/_expo/static/js/entry-abc.js" defer></script></body></html>');
  fs.writeFileSync(path.join(d, "_expo", "static", "js", "entry-abc.js"), "console.log('app');");
  return d;
}

test("a throwaway run seals the loader and the build, and every folder verifies", async () => {
  const dist = fakeDist(), out = path.join(tmp(), "app-out");
  const r = await buildAppOut({ dist, release: "0.2.0", out, throwaway: true });
  assert.equal(r.folders.length, 2);
  assert.ok(fs.existsSync(path.join(out, "index.html")) && fs.existsSync(path.join(out, "sw.js")), "the loader is at the root");
  assert.ok(fs.existsSync(path.join(out, "v", r.line.sha, "_expo", "static", "js", "entry-abc.js")), "the build is at v/<sha>");
  const pub = new Uint8Array(Buffer.from(r.pub, "base64url"));
  for (const f of r.folders) await verify(f, pub);
  // The deploy's pinned-key check refuses it: a throwaway key is not the release key.
  const other = new Uint8Array(crypto.randomBytes(32));
  await assert.rejects(verify(r.folders[1], other));
});

test("a changed file after sealing fails verification", async () => {
  const dist = fakeDist(), out = path.join(tmp(), "app-out");
  const r = await buildAppOut({ dist, release: "0.2.0", out, throwaway: true });
  fs.appendFileSync(path.join(r.folders[1], "_expo", "static", "js", "entry-abc.js"), "evil()");
  await assert.rejects(verify(r.folders[1], new Uint8Array(Buffer.from(r.pub, "base64url"))), /does not match/);
});

test("a PEM key from the environment signs, and a key that is not the pinned release key is refused on a real run", async () => {
  const pem = crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await assert.rejects(buildAppOut({ dist: fakeDist(), release: "0.2.0", out: path.join(tmp(), "o"), pem }), /not the pinned release key/);
  await assert.rejects(buildAppOut({ dist: fakeDist(), release: "0.2.0", out: path.join(tmp(), "o") }), /no signing key/);
  await assert.rejects(buildAppOut({ dist: fakeDist(), release: "0.2.0", out: path.join(tmp(), "o"), pem, throwaway: true }), /two ways/);
});

test("it refuses a missing build and a bad release", async () => {
  await assert.rejects(buildAppOut({ dist: tmp(), release: "0.2.0", out: path.join(tmp(), "o"), throwaway: true }), /no index.html/);
  await assert.rejects(buildAppOut({ dist: fakeDist(), release: "latest", out: path.join(tmp(), "o"), throwaway: true }), /x\.y\.z/);
});
