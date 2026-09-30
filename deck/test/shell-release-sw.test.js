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
  fs.writeFileSync(path.join(dir, "shell.json"), JSON.stringify({ v: 1, version: "0.2.0", files: [["/js/app.js", crypto.createHash("sha256").update(app).digest("hex")]] }));
  signRelease({ dir, version: "0.2.0", pem, key: pub });
  const served = /** @type {Record<string, Buffer>} */ ({});
  for (const n of ["SHA256SUMS", "SHA256SUMS.sig", "shell.json"]) served[n] = fs.readFileSync(path.join(dir, n));
  return { pub, served, app, dir };
}

function load(/** @type {{ signed?: boolean, pub: string, served: Record<string, Buffer | undefined> }} */ o) {
  const pick = (/** @type {RegExp} */ re) => { const m = re.exec(SW_SRC); assert.ok(m, String(re)); return m[0]; };
  const src = [pick(/function hex\([\s\S]*?\n}/), pick(/function fromBase64\([\s\S]*?\n}/), pick(/async function verifyShell\([\s\S]*?\n}\n/), pick(/function semverLess\([\s\S]*?\n}\n/), "verifyShell;"].join("\n");
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
  const r = await load({ signed: false, pub: "", served: {} })([], []);
  assert.deepEqual({ ...r }, { ok: true, checked: false });
});

test("a real signed release, matching file: checked and ok", async () => {
  const { pub, served, app } = release();
  const r = await load({ pub, served })([{ path: "/js/app.js", bytes: enc(app.toString()) }], ["/js/app.js"]);
  assert.deepEqual([r.ok, r.checked, r.version, r.files.length], [true, true, "0.2.0", 1]);
});

test("a file that differs from the release is refused", async () => {
  const { pub, served } = release();
  const r = await load({ pub, served })([{ path: "/js/app.js", bytes: enc("evil()") }], ["/js/app.js"]);
  assert.equal(r.ok, false); assert.match(r.why, /hash mismatch/);
});

test("a signature by another key is refused", async () => {
  const { served } = release();
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const r = await load({ pub: other, served })([], []);
  assert.equal(r.ok, false); assert.equal(r.why, "bad signature");
});

test("a swapped shell.json that SHA256SUMS does not list is refused", async () => {
  const { pub, served } = release();
  const forged = Buffer.from(JSON.stringify({ v: 1, files: [["/js/app.js", "0".repeat(64)]] }));
  const r = await load({ pub, served: { ...served, "shell.json": forged } })([], []);
  assert.match(r.why, /not the signed one/);
});

test("a signed build with a release file missing is refused, not skipped", async () => {
  const { pub, served } = release();
  const r = await load({ pub, served: { ...served, "SHA256SUMS.sig": undefined } })([], []);
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

// launch's shared vector (box-update.test.js VECTOR, CHAT 10:00): Ed25519 is deterministic, so the box updater,
// the Mac installer, sign-manifest and this worker all have to agree on these exact bytes.
test("launch's shared vector: sw.js verifies it, and refuses the same signature without the domain prefix", async () => {
  const pub = "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
  const sig = "X+aWDX+6p5YDh32E4tUXAHKEvCwi36rUm4I889QLs2I6b4hlP0J05o8PNtuyZnsCaqMkiv2MWmqJ3fllTLIzDA==";
  const shell = Buffer.from(JSON.stringify({ v: 1, files: [] }));
  // The vector's own SHA256SUMS does not list shell.json, so the chain stops at that link: that is
  // "not the signed one", which means the signature step itself passed.
  const sums = Buffer.from(`${"a".repeat(64)}  manifest.json\n${"b".repeat(64)}  vyre.tgz\n`);
  const served = { SHA256SUMS: sums, "SHA256SUMS.sig": Buffer.from(sig + "\n"), "shell.json": shell };
  const ok = await load({ pub, served })([], []);
  assert.match(ok.why, /not the signed one/, "signature verified; only the shell.json link fails");
  // A signature made over the bare SHA256SUMS (no prefix) must fail at the signature step.
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const bare = crypto.sign(null, sums, privateKey).toString("base64");
  const pub2 = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
  const r = await load({ pub: pub2, served: { ...served, "SHA256SUMS.sig": Buffer.from(bare) } })([], []);
  assert.equal(r.why, "bad signature");
});

test("a required file the origin withheld, or that shell.json does not list, is refused", async () => {
  const { pub, served, app } = release();
  const files = [{ path: "/js/app.js", bytes: enc(app.toString()) }];
  const missing = await load({ pub, served })(files, ["/js/app.js", "/js/other.js"]);
  assert.equal(missing.ok, false); assert.match(missing.why, /not listed: \/js\/other.js/);
  const withheld = await load({ pub, served })([], ["/js/app.js"]);
  assert.equal(withheld.ok, false); assert.match(withheld.why, /not fetched: \/js\/app.js/);
});

test("an older signed release than the highest accepted is refused", async () => {
  const { pub, served, app } = release();
  const files = [{ path: "/js/app.js", bytes: enc(app.toString()) }];
  const r = await load({ pub, served })(files, ["/js/app.js"], "0.2.1");
  assert.equal(r.ok, false); assert.match(r.why, /older than 0.2.1/);
  assert.equal((await load({ pub, served })(files, ["/js/app.js"], "0.2.0")).ok, true);
  assert.equal((await load({ pub, served })(files, ["/js/app.js"], "0.1.9")).ok, true);
});

// The whole worker, with a fake cache: a signed shell is only ever written with the bytes the release listed.
test("a revalidation with different bytes leaves the cached shell file unchanged", async () => {
  const good = Buffer.from("export const x = 1;");
  const sha = crypto.createHash("sha256").update(good).digest("hex");
  const store = new Map();
  store.set("/__shell-hashes", JSON.stringify([["/js/app.js", sha]]));
  const name = k => (typeof k === "string" ? k : new URL(k.url).pathname);
  const cache = { match: async k => (store.has(name(k)) ? new Response(store.get(name(k))) : undefined), put: async (k, r) => { store.set(name(k), await r.text()); } };
  const on = {};
  const src = SW_SRC.replace("const SHELL_SIGNED = false;", "const SHELL_SIGNED = true;");
  let served = "export const x = 1;";
  vm.runInNewContext(src, { self: { addEventListener: (t, fn) => { on[t] = fn; } }, location: { origin: "https://box" }, URL, Response, TextEncoder, TextDecoder, atob, crypto: globalThis.crypto, console,
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async () => Object.defineProperty(new Response(served), "type", { value: "basic" }) });
  const ask = async () => {
    let p; on.fetch({ request: { url: "https://box/js/app.js", method: "GET", mode: "no-cors" }, respondWith: x => { p = x; }, waitUntil: x => x });
    return p;
  };
  served = "evil()";
  await (await ask()); // no hit yet: a first visit with wrong bytes gets nothing
  assert.equal(store.has("/js/app.js"), false, "wrong bytes are never cached");
  served = "export const x = 1;";
  await ask(); await new Promise(r => setTimeout(r, 20));
  assert.equal(store.get("/js/app.js"), "export const x = 1;");
  served = "evil()";
  const r = await ask(); await new Promise(r2 => setTimeout(r2, 20));
  assert.equal(await r.text(), "export const x = 1;", "the cached copy is served");
  assert.equal(store.get("/js/app.js"), "export const x = 1;", "and stays");
});
