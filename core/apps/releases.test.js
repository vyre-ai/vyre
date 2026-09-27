// @ts-check
// The releases module in a real vyred on a temp home: the owner's key made once in the vault,
// the manifest rewritten to the signed file, the APK immutable and signed once, names that are
// not the release refused, and nobody but the owner's devices served.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../daemon/index.js";
import { request } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { storedZip, verifyApk } from "./testing.js";
import { checkManifest } from "./index.js";

const FILE = "vyre-0.4.0-abc1234.apk";
const OWNER = "tailnet:alex", DEVICE = "device:abcdefghijklmnop", GUEST = "tailnet-guest:juno", AGENT = "tailnet:agent:kit";
const sha = b => crypto.createHash("sha256").update(b).digest("hex");

/** A vyred with the releases module on, a release in its folder, and an HTTP door that names the caller the way a listener would. */
async function box(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: ["releases"], disable: ["recall", "memory", "learn"] } }));
  const dir = path.join(root, "releases", "android");
  fs.mkdirSync(dir, { recursive: true });
  const unsigned = storedZip([{ name: "AndroidManifest.xml", data: Buffer.from("<manifest/>") }, { name: "res/raw/northwind.txt", data: crypto.randomBytes(4096) }]);
  fs.writeFileSync(path.join(dir, FILE), unsigned);
  const manifest = { version: "0.4.0", versionCode: 40, sha: "abc1234", sha256: sha(unsigned), size: unsigned.length, minSdk: 26, built: "2026-09-27T00:00:00Z", file: FILE };
  fs.writeFileSync(path.join(dir, "android.json"), JSON.stringify(manifest));
  let d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const handle = () => d.registry.deps.handler({});
  const server = http.createServer((req, res) => handle()(req, res, String(req.headers["x-test-caller"])));
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const port = /** @type {any} */ (server.address()).port;
  /** @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: Buffer }>} */
  const get = (p, caller = OWNER, method = "GET") => new Promise((resolve, reject) => {
    http.request({ host: "127.0.0.1", port, path: p, method, headers: { "x-test-caller": caller }, agent: false }, res => {
      const chunks = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
  const restart = async () => { await d.stop(); d = await start({ root, presence: present, log: () => {} }); };
  return { root, dir, unsigned, manifest, get, restart, d: () => d };
}

test("the manifest names the signed file, and the APK is served signed and immutable", async t => {
  const b = await box(t);
  const m = await b.get("/v1/releases/android");
  assert.equal(m.status, 200, m.body.toString());
  assert.equal(m.headers["cache-control"], "no-store");
  const man = JSON.parse(m.body.toString());
  for (const k of ["version", "versionCode", "sha", "minSdk", "built", "file"]) assert.deepEqual(man[k], b.manifest[k], k);
  assert.notEqual(man.sha256, b.manifest.sha256, "sha256 is the signed file's, not CI's");
  assert.match(man.cert_sha256, /^[0-9a-f]{64}$/);

  const a = await b.get(`/v1/releases/android?file=${FILE}`);
  assert.equal(a.status, 200);
  assert.equal(a.headers["content-type"], "application/vnd.android.package-archive");
  assert.match(String(a.headers["cache-control"]), /immutable/);
  assert.equal(sha(a.body), man.sha256);
  assert.equal(a.body.length, man.size);
  const v = verifyApk(a.body);
  assert.equal(sha(v.v3.certDer), man.cert_sha256);
  assert.equal(v.v3.cert.subject, "CN=Vyre test-box");

  // The key is the vault's, granted to this module alone, and releases.cert names the same certificate.
  const item = (await b.d().registry.call("vault.list", {}, "cli")).data.items.find(x => x.name === "android-release-key");
  assert.deepEqual(item.grants, [{ module: "releases" }]);
  assert.equal((await b.d().registry.call("releases.cert", {}, OWNER)).data.cert_sha256, man.cert_sha256);
  assert.equal((await b.d().registry.call("releases.cert", {}, "mcp")).error.code, "denied", "Claude does not handle the release key");

  // Signed once: the cached file is reused, not signed again.
  const cached = path.join(b.dir, `signed-${FILE}`);
  const mtime = fs.statSync(cached).mtimeMs;
  assert.equal(sha((await b.get(`/v1/releases/android?file=${FILE}`)).body), man.sha256);
  assert.equal(fs.statSync(cached).mtimeMs, mtime);
  const h = await b.get(`/v1/releases/android?file=${FILE}`, OWNER, "HEAD");
  assert.equal(h.status, 200); assert.equal(h.body.length, 0); assert.equal(Number(h.headers["content-length"]), man.size);

  // A device paired through the relay is the owner too.
  assert.equal((await b.get("/v1/releases/android", DEVICE)).status, 200);

  // The same key after a restart: updates install over each other.
  await b.restart();
  assert.equal(JSON.parse((await b.get("/v1/releases/android")).body.toString()).cert_sha256, man.cert_sha256);
});

test("names that are not the release are refused", async t => {
  const b = await box(t);
  for (const p of [`/v1/releases/android?file=signed-${FILE}`, "/v1/releases/android?file=vyre-0.3.0-0000000.apk", "/v1/releases/android?file=a/b.apk",
    "/v1/releases/android?file=..%2Fandroid.json", "/v1/releases/android?file=%2e%2e%2fandroid.json", "/v1/releases/android?file=android.json",
    "/v1/releases/android?file=", "/v1/releases/ios"]) {
    const r = await b.get(p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes(Buffer.from("PK")), `${p} served no zip`);
  }
  assert.equal((await b.get("/v1/releases/android", OWNER, "DELETE")).status, 405);
  assert.throws(() => checkManifest({ ...b.manifest, file: "../x.apk" }), /file/);
  assert.throws(() => checkManifest({ ...b.manifest, minSdk: 21 }), /below 24/);
});

test("guests, agents and socket labels get nothing", async t => {
  const b = await box(t);
  for (const who of [GUEST, AGENT, "anonymous"]) {
    // An agent's node is stopped by vyred's router first (403: no agent key); the rest reach the route and get 404.
    for (const p of ["/v1/releases/android", `/v1/releases/android?file=${FILE}`]) {
      const r = await b.get(p, who);
      assert.equal(r.status, who === AGENT ? 403 : 404, `${who} ${p}`);
      assert.ok(!r.body.includes(Buffer.from("PK")) && !r.body.includes(Buffer.from("cert_sha256")), `${who} ${p} got nothing`);
    }
  }
  // On the socket even "cli" is only a label, and not one of the owner's devices.
  const r = await request("GET", "/v1/releases/android", undefined, { root: b.root, caller: "cli" });
  assert.equal(r.error && r.error.code, "not_found");
  assert.ok(!fs.existsSync(path.join(b.dir, `signed-${FILE}`)), "nothing was signed for them");
});

test("a build that does not match its manifest is refused, and a lost key makes a new one", async t => {
  const b = await box(t);
  const first = JSON.parse((await b.get("/v1/releases/android")).body.toString());
  // The owner deletes the key (or loses the vault): the next request makes a new one and signs again.
  assert.ok(!(await b.d().registry.call("vault.delete", { name: "android-release-key" }, "cli")).error);
  await b.restart();
  const second = JSON.parse((await b.get("/v1/releases/android")).body.toString());
  assert.notEqual(second.cert_sha256, first.cert_sha256);
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(sha(verifyApk((await b.get(`/v1/releases/android?file=${FILE}`)).body).v2.certDer), second.cert_sha256);

  fs.writeFileSync(path.join(b.dir, "android.json"), JSON.stringify({ ...b.manifest, sha: "def5678", sha256: "0".repeat(64) }));
  const r = await b.get("/v1/releases/android");
  assert.equal(r.status, 409);
  assert.equal(JSON.parse(r.body.toString()).error.code, "release_mismatch");
  fs.rmSync(path.join(b.dir, "android.json"));
  assert.equal(JSON.parse((await b.get("/v1/releases/android")).body.toString()).error.code, "no_release");
});

test("releases.sign signs the placed build ahead of the first download, for `vyre update`", async t => {
  const b = await box(t);
  const r = await b.d().registry.call("releases.sign", {}, "cli");
  assert.ok(r.data, JSON.stringify(r));
  assert.equal(r.data.file, FILE);
  assert.ok(fs.existsSync(path.join(b.dir, `signed-${FILE}`)), "signed before anyone asked");
  const man = JSON.parse((await b.get("/v1/releases/android")).body.toString());
  assert.equal(r.data.sha256, man.sha256);
  assert.equal(r.data.cert_sha256, man.cert_sha256);
  assert.equal((await b.d().registry.call("releases.sign", {}, "mcp")).error.code, "denied");
  fs.rmSync(path.join(b.dir, "android.json"));
  assert.equal((await b.d().registry.call("releases.sign", {}, "cli")).error.code, "no_release");
});
