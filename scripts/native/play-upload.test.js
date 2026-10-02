// @ts-check
// play-upload.mjs against a fake Play on this machine: the token request is signed by the service account's key (checked with the public
// half), the four Play calls come in order with the bearer token, the AAB bytes arrive intact, a refusal at any step fails, and the key
// and token never appear in what the script prints. Never real Google.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "play-upload.mjs");

async function fakePlay(t, { failAt = "" } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = req.url || "";
      seen.push({ method: req.method, url, auth: req.headers.authorization, body });
      const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (url === "/token") {
        const [h, c, s] = (new URLSearchParams(body.toString()).get("assertion") || "").split(".");
        const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s || "", "base64url"));
        return ok ? send(200, { access_token: "tok-1" }) : send(401, { error: "bad assertion" });
      }
      const step = url.includes(":commit") ? "commit" : url.includes("/tracks/") ? "track" : url.includes("/bundles") ? "bundle" : url.endsWith("/edits") ? "edit" : "?";
      if (step === failAt) return send(403, { error: "no" });
      if (step === "edit") return send(200, { id: "e1" });
      if (step === "bundle") return send(200, { versionCode: 42 });
      return send(200, {});
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const sa = JSON.stringify({ client_email: "play@vyre.test", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  return { seen, base, sa, privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

const aabFile = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "play-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, "app.aab");
  fs.writeFileSync(f, Buffer.concat([Buffer.from("PK"), crypto.randomBytes(4000)]));
  return f;
};
// Asynchronous: the fake Play lives in this process and must keep answering while the script runs.
const run = (p, aab, extra = []) => new Promise(resolve => {
  const c = spawn(process.execPath, [SCRIPT, "--aab", aab, "--package", "sh.vyre.app", "--track", "internal", ...extra],
    { env: { PATH: process.env.PATH, PLAY_SERVICE_ACCOUNT_JSON: p.sa, PLAY_API_BASE: p.base, PLAY_TOKEN_URL: `${p.base}/token` } });
  let stdout = "", stderr = "";
  c.stdout.on("data", d => (stdout += d)); c.stderr.on("data", d => (stderr += d));
  c.on("close", status => resolve({ status, stdout, stderr }));
});

test("play-upload: signed token, edit, bundle bytes, track release, commit, in order; nothing secret printed", async t => {
  const p = await fakePlay(t);
  const aab = aabFile(t);
  const r = await run(p, aab, ["--name", "0.2.2 (12)"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /uploaded versionCode 42 to internal \(draft\)/);
  assert.deepEqual(p.seen.map(s => `${s.method} ${s.url.split("?")[0].replace("/androidpublisher/v3/applications/sh.vyre.app", "").replace("/upload/androidpublisher/v3/applications/sh.vyre.app", "/upload")}`),
    ["POST /token", "POST /edits", "POST /upload/edits/e1/bundles", "PUT /edits/e1/tracks/internal", "POST /edits/e1:commit"]);
  assert.ok(p.seen.slice(1).every(s => s.auth === "Bearer tok-1"));
  assert.ok(p.seen[2].body.equals(fs.readFileSync(aab)), "the AAB bytes arrive intact");
  assert.deepEqual(JSON.parse(p.seen[3].body.toString()), { track: "internal", releases: [{ name: "0.2.2 (12)", status: "draft", versionCodes: ["42"] }] });
  const printed = r.stdout + r.stderr;
  assert.ok(!printed.includes("tok-1") && !printed.includes("PRIVATE KEY"), "no token or key in the output");
});

test("play-upload: a refusal at any step fails and says which; a bad input is refused before any call", async t => {
  for (const failAt of ["edit", "bundle", "track", "commit"]) {
    const p = await fakePlay(t, { failAt });
    const r = await run(p, aabFile(t));
    assert.equal(r.status, 1, `${failAt} must fail`);
    assert.match(r.stderr, /failed: 403/);
    assert.ok(!r.stderr.includes("PRIVATE KEY"));
  }
  const p = await fakePlay(t);
  const notAab = path.join(os.tmpdir(), `x-${process.pid}.aab`); fs.writeFileSync(notAab, "hello"); t.after(() => fs.rmSync(notAab, { force: true }));
  assert.match((await run(p, notAab)).stderr, /not an AAB/);
  assert.match((await run(p, aabFile(t), ["--status", "oops"])).stderr, /status must be/);
  assert.equal(p.seen.length, 0, "no call was made for a bad input");
  const bad = { ...p, sa: "not json" };
  assert.match((await run(bad, aabFile(t))).stderr, /not JSON/);
});
