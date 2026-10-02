// @ts-check
// companion-core: a core the Windows app started joins through the app, seals its key with the app, and signs each call to the box.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { companionCoreSide, askApp, FILE } from "./companion-core.js";
import { tokenMessage, boxId, helloMessage } from "./companion.js";

const ED = crypto.generateKeyPairSync("ed25519");
const BOX_PUB = ED.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

/** A stand-in for the app's pipe: speaks the one-line protocol over a unix socket. */
function fakeApp(t, handler) {
  const sock = path.join(tempHome(t), "app.sock");
  const seen = [];
  const server = net.createServer(c => {
    let b = "";
    c.on("data", d => { b += d; if (!b.includes("\n")) return; const req = JSON.parse(b.split("\n")[0]); seen.push(req); c.end(JSON.stringify(handler(req)) + "\n"); });
  });
  server.listen(sock);
  t.after(() => server.close());
  return { sock, seen };
}

/** A stand-in for the box: checks each token the way core/link/companion.js verifyCall does, with the key the core offered. */
function fakeBox(t, coreSpki, { lie = false } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let b = [];
    req.on("data", c => b.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(b);
      const url = new URL(req.url || "/", "http://x");
      const isChunk = url.pathname.startsWith("/v1/sync/upload/");
      const parsed = isChunk ? null : JSON.parse(raw.toString());
      const tok = String(isChunk ? req.headers["x-vyre-companion"] : parsed.companion || parsed.token).split(".");
      const [tag, companion, ts, nonce, sig] = tok;
      let input, tool;
      if (isChunk) { tool = "sync.upload.chunk"; input = { upload: decodeURIComponent(url.pathname.split("/").pop() || ""), offset: Number(url.searchParams.get("offset")), data: raw }; }
      else { tool = decodeURIComponent(url.pathname.slice("/v1/tools/".length)); const { companion: _c, token: _t, ...rest } = parsed; input = rest; }
      const key = crypto.createPublicKey({ key: Buffer.from(coreSpki(), "base64url"), format: "der", type: "spki" });
      const ok = tag === "c1" && crypto.verify("sha256", tokenMessage({ box: boxId(BOX_PUB), companion, ts, nonce, tool, input }), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
      calls.push({ tool, ok, companion });
      res.setHeader("content-type", "application/json");
      if (!ok) { res.statusCode = 403; return res.end(JSON.stringify({ error: { code: "denied", message: "bad token" } })); }
      if (tool === "link.companion.hello") {
        const sk = lie ? crypto.generateKeyPairSync("ed25519").privateKey : ED.privateKey;
        const proof = crypto.sign(null, helloMessage({ box: boxId(BOX_PUB), companion, ts, nonce }), sk).toString("base64url");
        return res.end(JSON.stringify({ data: { paired: true, companion, box: { pub: BOX_PUB, id: boxId(BOX_PUB) }, proof } }));
      }
      res.end(JSON.stringify({ data: isChunk ? { offset: input.offset + raw.length } : tool === "sync.upload.plan" ? { new: [], changed: [], done: [], excluded: [] } : { upload: "11111111-1111-4111-8111-111111111111", offset: 0 } }));
    });
  });
  return new Promise(r => server.listen(0, "127.0.0.1", () => { t.after(() => server.close()); r({ url: `http://127.0.0.1:${server.address().port}`, calls }); }));
}

function fakeCtx(root) {
  const tools = new Map();
  return { tools, paths: { root }, config: { name: "alex-pc" }, tool: (n, d) => tools.set(n, d) };
}

const sealer = { seal: d => Buffer.from(d, "utf8").reverse().toString("base64url"), unseal: b => Buffer.from(b, "base64url").reverse().toString("utf8") };

test("companion-core: it joins through the app once, seals its key, and signs every call with it", { timeout: 20000 }, async t => {
  const root = tempHome(t);
  let spki = "";
  /** @type {any} */ let box;
  const app = fakeApp(t, req => {
    if (req.op === "companion") { spki = req.core; return { ok: true, id: "c0ffee00-0000-4000-8000-000000000001", approved: "window", box: { pub: BOX_PUB, id: boxId(BOX_PUB) }, address: box.url }; }
    if (req.op === "seal") return { ok: true, blob: sealer.seal(req.data) };
    if (req.op === "unseal") return { ok: true, data: sealer.unseal(req.blob) };
    return { ok: false, error: "no" };
  });
  box = await fakeBox(t, () => spki);
  const ctx = fakeCtx(root);
  const side = companionCoreSide(ctx, { pipe: app.sock, insecure: true, verify: async () => ({ stableId: "x" }) });
  const t_ = n => /** @type {any} */ (ctx.tools.get(n));

  assert.deepEqual(await t_("link.status").run({}), { paired: false, companion: true });
  const plan = await t_("link.remote").run({ tool: "sync.upload.plan", input: { files: [{ path: "a/b.jsonl", bytes: 3, hash: "h" }] } });
  assert.deepEqual(plan.result.data, { new: [], changed: [], done: [], excluded: [] });
  const start = await t_("link.remote").run({ tool: "sync.upload.start", input: { path: "a/b.jsonl", bytes: 3, hash: "h" } });
  assert.equal(start.result.data.upload, "11111111-1111-4111-8111-111111111111");
  const chunk = await t_("link.upload").run({ upload: start.result.data.upload, offset: 0, data: Buffer.from("abc") });
  assert.deepEqual(chunk, { offset: 3 });
  assert.deepEqual(box.calls.map(c => [c.tool, c.ok]), [["link.companion.hello", true], ["sync.upload.plan", true], ["sync.upload.start", true], ["sync.upload.chunk", true]], "hello first, once");
  assert.deepEqual(app.seen.map(r => r.op), ["companion", "seal"], "joined once, sealed once");
  assert.equal(app.seen[0].name, "alex-pc");

  // The private key is on disk only sealed.
  const saved = JSON.parse(fs.readFileSync(path.join(root, FILE), "utf8"));
  assert.equal(saved.companion, "c0ffee00-0000-4000-8000-000000000001");
  assert.equal(saved.box.id, boxId(BOX_PUB));
  assert.ok(!JSON.stringify(saved).includes("BEGIN"), "no PEM");
  assert.equal((await t_("link.status").run({})).paired, true);

  // A restart reads the file and asks the app to unseal; it does not join again.
  await side.stop();
  const ctx2 = fakeCtx(root);
  companionCoreSide(ctx2, { pipe: app.sock, insecure: true, verify: async () => ({ stableId: "x" }) });
  const again = await /** @type {any} */ (ctx2.tools.get("link.remote")).run({ tool: "sync.upload.plan", input: { files: [] } });
  assert.ok(again.result.data);
  assert.deepEqual(app.seen.map(r => r.op), ["companion", "seal", "unseal"]);
  assert.ok(box.calls.every(c => c.ok));
});

test("companion-core: only the upload tools leave the PC, and a missing or refusing app is said in plain words", { timeout: 20000 }, async t => {
  const root = tempHome(t);
  const ctx = fakeCtx(root);
  companionCoreSide(ctx, { pipe: undefined });
  const t_ = n => /** @type {any} */ (ctx.tools.get(n));
  for (const tool of ["vault.get", "link.pair", "sync.consent.set", "threads.list", "sync.upload.chunk"]) {
    const r = await t_("link.remote").run({ tool, input: {} });
    assert.equal(r.result.error.code, "denied", tool);
  }
  const noApp = await t_("link.remote").run({ tool: "sync.upload.plan", input: { files: [] } });
  assert.equal(noApp.result.error.code, "no_app");
  assert.match(noApp.result.error.message, /not started by the Vyre app/);
  await assert.rejects(() => t_("link.upload").run({ upload: "../../x", offset: 0, data: Buffer.from("x") }), /upload must be the id/);

  const app = fakeApp(t, () => ({ ok: false, error: "the person has not allowed this" }));
  const ctx2 = fakeCtx(tempHome(t));
  companionCoreSide(ctx2, { pipe: app.sock });
  const refused = await /** @type {any} */ (ctx2.tools.get("link.remote")).run({ tool: "sync.upload.plan", input: { files: [] } });
  assert.match(refused.result.error.message, /the person has not allowed this/);
  const pending = fakeApp(t, req => (req.op === "companion" ? { ok: true, pending: true } : { ok: false, error: "no" }));
  const ctx3 = fakeCtx(tempHome(t));
  companionCoreSide(ctx3, { pipe: pending.sock });
  const waiting = await /** @type {any} */ (ctx3.tools.get("link.remote")).run({ tool: "sync.upload.plan", input: { files: [] } });
  assert.equal(waiting.result.error.code, "pending");
  assert.match(waiting.result.error.message, /allow this PC's helper/);
});

test("companion-core: sync.consent is checked on the server with an empty plan, so the person hears its reason", { timeout: 20000 }, async t => {
  const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.statusCode = 403; res.end(JSON.stringify({ error: { code: "denied", message: "import is not switched on for alex-pc" } })); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const app = fakeApp(t, req => req.op === "companion" ? { ok: true, id: "c0ffee00-0000-4000-8000-000000000002", box: { pub: BOX_PUB, id: boxId(BOX_PUB) }, address: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` } : { ok: true, blob: "x", data: "x" });
  const ctx = fakeCtx(tempHome(t));
  companionCoreSide(ctx, { pipe: app.sock, insecure: true, verify: async () => ({ stableId: "x" }) });
  const call = /** @type {any} */ (ctx.tools.get("link.call"));
  await assert.rejects(() => call.run({ tool: "sync.consent", input: { machine: "alex-pc", on: true } }), /import is not switched on for alex-pc/);
  assert.deepEqual(await call.run({ tool: "sync.consent", input: { machine: "alex-pc", on: false } }), {}, "switching off needs nothing from the server");
  await assert.rejects(() => call.run({ tool: "vault.get", input: {} }), /not something this PC's helper may ask/);
});

test("askApp: one line each way, and the connection ends", async t => {
  const app = fakeApp(t, req => ({ ok: true, echo: req.op }));
  assert.deepEqual(await askApp(app.sock, { v: 1, op: "x" }), { ok: true, echo: "x" });
  await assert.rejects(() => askApp(path.join(tempHome(t), "nope.sock"), { v: 1 }, 1000), /could not reach the app/);
});

test("companion-core: a server that cannot prove it is the pinned one gets nothing, not even a file name", { timeout: 20000 }, async t => {
  let spki = "";
  let box;
  const app = fakeApp(t, req => req.op === "companion" ? (spki = req.core, { ok: true, id: "c0ffee00-0000-4000-8000-000000000003", box: { pub: BOX_PUB, id: boxId(BOX_PUB) }, address: box.url }) : { ok: true, blob: "x", data: "x" });
  box = await fakeBox(t, () => spki, { lie: true });
  const ctx = fakeCtx(tempHome(t));
  companionCoreSide(ctx, { pipe: app.sock, insecure: true, verify: async () => ({ stableId: "x" }) });
  const r = await /** @type {any} */ (ctx.tools.get("link.remote")).run({ tool: "sync.upload.plan", input: { files: [{ path: "secret.jsonl", bytes: 1, hash: "h" }] } });
  assert.equal(r.result.error.code, "not_box");
  assert.match(r.result.error.message, /did not prove/);
  assert.deepEqual(box.calls.map(c => c.tool), ["link.companion.hello"], "only hello was sent");
  await assert.rejects(() => /** @type {any} */ (ctx.tools.get("link.upload")).run({ upload: "11111111-1111-4111-8111-111111111111", offset: 0, data: Buffer.from("x") }), /did not prove/);
});

test("companion-core: the address the app returns must be a plain https origin", { timeout: 20000 }, async t => {
  for (const address of ["https://alex.vyre.run/evil", "https://u:p@alex.vyre.run", "http://alex.vyre.run", "alex.vyre.run", "https://alex.vyre.run?x=1"]) {
    const app = fakeApp(t, req => req.op === "companion" ? { ok: true, id: "c0ffee00-0000-4000-8000-000000000004", box: { pub: BOX_PUB, id: boxId(BOX_PUB) }, address } : { ok: true, blob: "x", data: "x" });
    const ctx = fakeCtx(tempHome(t));
    companionCoreSide(ctx, { pipe: app.sock });
    const r = await /** @type {any} */ (ctx.tools.get("link.remote")).run({ tool: "sync.upload.plan", input: { files: [] } });
    assert.equal(r.result.error.code, "bad_answer", address);
  }
});
