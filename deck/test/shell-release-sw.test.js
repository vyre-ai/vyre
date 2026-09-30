// @ts-check
// deck/sw.js verifyShell (reviewer N-H1) is a classic worker with no imports, so this test pulls its
// source out of the real file and runs it in Node (crypto.webcrypto is the browser's SubtleCrypto)
// against a REAL release made by scripts/sign-manifest.mjs and scripts/shell-hashes.mjs, signed with
// a throwaway key that the sandbox passes in as RELEASE_KEY.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { signRelease } from "../../scripts/sign-manifest.mjs";
import { shellHashes } from "../../scripts/shell-hashes.mjs";
import { RELEASE_KEY } from "../../core/vyre-core/release.js";
import { swWithBuild } from "../../core/daemon/build.js";

const SW_SRC = fs.readFileSync(path.join(import.meta.dirname, "..", "sw.js"), "utf8");
const enc = (/** @type {string} */ s) => new TextEncoder().encode(s).buffer;

function release() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-release-"));
  fs.writeFileSync(path.join(dir, "vyre.tgz"), "tarball");
  const app = Buffer.from("export const x = 1;");
  fs.writeFileSync(path.join(dir, "shell.json"), JSON.stringify({ v: 1, files: [["/js/app.js", crypto.createHash("sha256").update(app).digest("hex")]] }));
  signRelease({ dir, version: "0.2.0", pem, key: pub });
  const served = /** @type {Record<string, Buffer>} */ ({});
  for (const n of ["SHA256SUMS", "SHA256SUMS.sig", "shell.json"]) served[n] = fs.readFileSync(path.join(dir, n));
  return { pub, served, app, dir };
}

function load(/** @type {{ signed?: boolean, pub: string, served: Record<string, Buffer | undefined> }} */ o) {
  const pick = (/** @type {RegExp} */ re) => { const m = re.exec(SW_SRC); assert.ok(m, String(re)); return m[0]; };
  const src = [pick(/function hex\([\s\S]*?\n}/), pick(/function fromBase64\([\s\S]*?\n}/), pick(/async function verifyShell\([\s\S]*?\n}\n/), "verifyShell;"].join("\n");
  const fetch = async (/** @type {string} */ url) => {
    const b = o.served[url.replace("/release/", "")];
    return b ? { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return vm.runInNewContext(src, { crypto: globalThis.crypto, TextEncoder, TextDecoder, atob, fetch, console, RELEASE_KEY: o.pub, SHELL_SIGNED: o.signed ?? true });
}

test("the pinned key in sw.js is the release key", () => {
  assert.equal(/const RELEASE_KEY = "([^"]+)"/.exec(SW_SRC)?.[1], RELEASE_KEY);
});

test("unsigned build (dev, testbox): unchecked, passes", async () => {
  const r = await load({ signed: false, pub: "", served: {} })([]);
  assert.deepEqual({ ...r }, { ok: true, checked: false });
});

test("a real signed release, matching file: checked and ok", async () => {
  const { pub, served, app } = release();
  assert.deepEqual({ ...(await load({ pub, served })([{ path: "/js/app.js", bytes: enc(app.toString()) }])) }, { ok: true, checked: true });
});

test("a file that differs from the release is refused", async () => {
  const { pub, served } = release();
  const r = await load({ pub, served })([{ path: "/js/app.js", bytes: enc("evil()") }]);
  assert.equal(r.ok, false); assert.match(r.why, /hash mismatch/);
});

test("a signature by another key is refused", async () => {
  const { served } = release();
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const r = await load({ pub: other, served })([]);
  assert.equal(r.ok, false); assert.equal(r.why, "bad signature");
});

test("a swapped shell.json that SHA256SUMS does not list is refused", async () => {
  const { pub, served } = release();
  const forged = Buffer.from(JSON.stringify({ v: 1, files: [["/js/app.js", "0".repeat(64)]] }));
  const r = await load({ pub, served: { ...served, "shell.json": forged } })([]);
  assert.match(r.why, /not the signed one/);
});

test("a signed build with a release file missing is refused, not skipped", async () => {
  const { pub, served } = release();
  const r = await load({ pub, served: { ...served, "SHA256SUMS.sig": undefined } })([]);
  assert.equal(r.ok, false); assert.match(r.why, /release files/);
});

test("scripts/shell-hashes.mjs lists every SHELL file with a real hash", () => {
  const s = shellHashes();
  assert.ok(s.files.length > 50);
  assert.ok(s.files.every(([p, h]) => p !== "/sw.js" && /^[0-9a-f]{64}$/.test(h)));
});

test("swWithBuild sets SHELL_SIGNED only when the release files are there", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sw-build-"));
  const b = { version: "0.2.0", commit: "abc", dirty: false, stamped: true };
  assert.match(swWithBuild(SW_SRC, /** @type {any} */ (b), repo), /const SHELL_SIGNED = false;/);
  fs.mkdirSync(path.join(repo, "deck", "release"), { recursive: true });
  fs.writeFileSync(path.join(repo, "deck", "release", "SHA256SUMS.sig"), "x");
  assert.match(swWithBuild(SW_SRC, /** @type {any} */ (b), repo), /const SHELL_SIGNED = true;/);
});
