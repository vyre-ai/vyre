// @ts-check
// Sign in from any device over the real listener: a page on another origin posts text/plain JSON to /login, derives the keys itself, and the box answers the same for every failure.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startLogin } from "./login-start.js";
import { loginPort } from "../../lib/login-door.js";
import { TEST_KDF } from "../../kernel/identity/master.js";
import { aesWrap, aesUnwrap } from "../../kernel/identity/wrap.js";
import { bundleHash, deriveLogin, loginMessage, registerMessage } from "../../kernel/identity/space-login.js";

const PERSON = "per_" + "a".repeat(26);
const PASSWORD = "correct horse battery";
const ORIGIN = "https://web.vyre.run";

async function box(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-login-"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  const events = /** @type {any[]} */ ([]);
  const ctx = {
    paths: { root }, log() {}, events: { emit: (/** @type {string} */ type, /** @type {any} */ p) => { events.push([type, p]); } },
    config: { machine: "server", name: "juniper", network: { origins: [ORIGIN] } },
    kernel: { owner: PERSON, space: "spc_aaaaaaaaaa", membership: async () => ({ member: false }) },
  };
  const door = await startLogin(ctx, { directory: { resolveById: async () => ({ entries: [{ kind: "device", pub }] }) } });
  t.after(() => door.stop());
  /** @returns {Promise<any>} */
  const post = (/** @type {any} */ body, /** @type {Record<string, string>} */ h = {}) => new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: loginPort(), path: "/login", method: "POST", headers: { "content-type": "text/plain", origin: ORIGIN, "content-length": String(Buffer.byteLength(text)), ...h } }, res => {
      /** @type {Buffer[]} */ const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, cors: res.headers["access-control-allow-origin"] || null, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.on("error", reject);
    req.end(text);
  });
  const sign = (/** @type {Buffer} */ m) => crypto.sign(null, m, privateKey).toString("base64url");
  return { post, events, pub, sign, door, root };
}

async function register(b, username = "alex") {
  const salt = crypto.randomBytes(16).toString("base64url");
  const d = deriveLogin(PASSWORD, salt, TEST_KDF);
  const rk = crypto.randomBytes(32);
  const bundle = { v: 1, username, id: PERSON, passwordWrap: aesWrap(d.K, rk, "vyre:master:password:v1") };
  const ts = Date.now();
  const r = await b.post({ op: "register", username, person: PERSON, pub: b.pub, ts, sig: b.sign(registerMessage("juniper", username, d.loginPub, bundleHash(bundle), ts)), salt, loginPub: d.loginPub, bundle });
  return { r, rk, salt };
}

test("a page signs in over the listener: register, begin, derive on the device, sign, finish, open the record, and the other devices are told", async (t) => {
  const b = await box(t);
  const { r, rk } = await register(b);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.cors, ORIGIN);
  const begin = await b.post({ op: "begin", username: "alex" });
  assert.equal(begin.status, 200);
  const d = deriveLogin(PASSWORD, begin.body.salt, TEST_KDF);
  const fin = await b.post({ op: "finish", username: "alex", challenge: begin.body.challenge, sig: d.sign(loginMessage("juniper", "alex", begin.body.challenge)), device: { label: "Aina's phone" } });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.deepEqual(aesUnwrap(d.K, fin.body.bundle.passwordWrap, "vyre:master:password:v1"), rk);
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0][0], "identity.new-device");
  assert.equal(b.events[0][1].label, "Aina's phone");
  const onDisk = fs.readFileSync(path.join(b.root, "identity", "logins.json"), "utf8");
  assert.equal(onDisk.includes(PASSWORD), false);
  assert.equal(onDisk.includes(d.K.toString("base64url")), false, "the server never held K");
});

test("every failure is the same answer over HTTP, another site gets no CORS grant, and a name is locked out after five misses", async (t) => {
  const b = await box(t);
  await register(b);
  const attempt = async (/** @type {string} */ username, /** @type {string} */ password) => {
    const begin = await b.post({ op: "begin", username });
    if (begin.status !== 200) return begin;
    const d = deriveLogin(password, begin.body.salt, TEST_KDF);
    return b.post({ op: "finish", username, challenge: begin.body.challenge, sig: d.sign(loginMessage("juniper", username, begin.body.challenge)) });
  };
  const wrong = await attempt("alex", "this is not the password");
  const none = await attempt("nobody", PASSWORD);
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, none.body);
  const elsewhere = await b.post({ op: "begin", username: "alex" }, { origin: "https://evil.example" });
  assert.equal(elsewhere.cors, null, "a page on another site cannot read the answer");
  for (let i = 0; i < 4; i += 1) await attempt("alex", "still not the password");
  const locked = await b.post({ op: "begin", username: "alex" });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, "rate_limited");
  assert.equal((await b.post({ op: "nonsense" })).status, 400);
});

test("a computer that is not a server opens no sign-in door", async () => {
  const door = await startLogin({ paths: { root: os.tmpdir() }, log() {}, events: { emit() {} }, config: { machine: "device", name: "alex" } });
  assert.equal(loginPort(), null);
  await door.stop();
});
