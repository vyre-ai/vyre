// @ts-check
// companion-core against a REAL box registry (link, sync and relay modules of this tree), with the tailnet door played by a small HTTP front:
// the join through a stand-in app, hello's proof, a plan, start, chunk and finish with real tokens, and the person's switch. The only
// stand-ins are the app's pipe and the door; both ends of the wire contract are the shipped code.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import * as config from "../config/index.js";
import { discover } from "../modules/index.js";
import { Registry } from "../modules/index.js";
import { Events } from "../events/index.js";
import { open } from "../store/index.js";
import { companionCoreSide } from "./companion-core.js";
import { boxKey } from "./assert.js";
import { boxId } from "./companion.js";

const CORE = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

async function boxRegistry(t) {
  const home = tempHome(t);
  const p = config.ensure(home);
  const want = ["link", "sync", "relay"];
  const found = discover([CORE]).filter(f => f.manifest && want.includes(f.manifest.name));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box", name: "testbox" }, paths: p, log: () => {} });
  await reg.start(found, { role: "box" });
  t.after(async () => { await reg.stop(); db.close(); });
  return { reg, db, root: home, call: (tool, input = {}, caller = "cli", meta = {}) => reg.call(tool, input, caller, meta) };
}

/** The tailnet door, in front of the real registry: the owner's node, a token or nothing. */
function door(t, call) {
  const peer = { stableId: "nPC", node: "pc.ts.net" };
  const server = http.createServer((req, res) => {
    const b = [];
    req.on("data", c => b.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(b);
      const url = new URL(req.url || "/", "http://x");
      let r;
      if (url.pathname.startsWith("/v1/sync/upload/")) {
        const companion = typeof req.headers["x-vyre-companion"] === "string" ? req.headers["x-vyre-companion"] : null;
        r = await call("sync.upload.chunk", { upload: decodeURIComponent(url.pathname.split("/").pop() || ""), offset: Number(url.searchParams.get("offset")), data: raw, ...(companion ? { companion } : {}) }, "tailnet:owner", { peer });
      } else {
        r = await call(decodeURIComponent(url.pathname.slice("/v1/tools/".length)), JSON.parse(raw.toString() || "{}"), "tailnet:owner", { peer });
      }
      res.setHeader("content-type", "application/json");
      res.statusCode = r.error ? 403 : 200;
      res.end(JSON.stringify(r));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => { t.after(() => server.close()); resolve(`http://127.0.0.1:${/** @type {any} */ (server.address()).port}`); }));
}

/** The app's pipe, standing in for the app: it does what the app does for a join, by calling the box as the paired app device would. */
function fakeApp(t, { call, db, root, address, appId }) {
  const sock = path.join(tempHome(t), "app.sock");
  const server = net.createServer(c => {
    let b = "";
    c.on("data", async d => {
      b += d;
      if (!b.includes("\n")) return;
      const req = JSON.parse(b.split("\n")[0]);
      let out;
      if (req.op === "companion") {
        // The device is just paired (inside the window), kind app, with its presence key.
        const r = await call("link.companion.pair", { core: req.core, name: req.name, nonce: req.nonce, ts: Date.now() }, `device:${appId}`, { person: { id: "p", kind: "bearer" }, presence: { keyId: "kh1" } });
        out = r.error ? { ok: false, error: r.error.message } : { ok: true, id: r.data.id, approved: r.data.approved, box: r.data.box, address };
      } else if (req.op === "seal") out = { ok: true, blob: Buffer.from(req.data, "base64url").reverse().toString("base64url") };
      else if (req.op === "unseal") out = { ok: true, data: Buffer.from(req.blob, "base64url").reverse().toString("base64url") };
      c.end(JSON.stringify(out) + "\n");
    });
  });
  server.listen(sock);
  t.after(() => server.close());
  return sock;
}

function deviceCtx(root) {
  const tools = new Map();
  return { tools, paths: { root }, config: { name: "alex-pc" }, tool: (n, d) => tools.set(n, d) };
}

test("companion-core against the real box: join through the app, hello proof, and a file that lands in synced/<name>/", { timeout: 60_000 }, async t => {
  const { call, db, root } = await boxRegistry(t);
  const APP = "abcdefgabcdefgab";
  db.prepare("INSERT INTO relay_devices (id, name, pub, presence_key, paired_at, kind, trusted) VALUES (?, 'alex desktop', 'p', 'kh1', ?, 'app', 1)").run(APP, Date.now() - 60_000);
  const address = await door(t, call);
  const sock = fakeApp(t, { call, db, root, address, appId: APP });
  const ctx = deviceCtx(tempHome(t));
  companionCoreSide(ctx, { pipe: sock, insecure: true, verify: async () => ({ stableId: "x" }) });
  const tool = n => /** @type {any} */ (ctx.tools.get(n));

  // The person has not switched import on for this PC: the server says so in its own words.
  await assert.rejects(() => tool("link.call").run({ tool: "sync.consent", input: { machine: "alex-pc", on: true } }), e => { assert.ok(String(e.message).length > 5); return true; });
  const consent = await call("sync.consent", { machine: "alex-pc", on: true }, "cli");
  assert.ok(!consent.error, JSON.stringify(consent.error));
  // The core was registered by the join (window path) and its key pinned.
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.paths.root, "companion.json"), "utf8"));
  assert.equal(saved.box.id, boxId(boxKey(root).publicKey), "pinned the box's real key");
  assert.equal(/** @type {any} */ (db.prepare("SELECT kind FROM link_peers WHERE id = ?").get(saved.companion)).kind, "companion");

  const text = "line one\nline two\n";
  const h = crypto.createHash("sha256").update(text).digest("hex");
  const plan = await tool("link.remote").run({ tool: "sync.upload.plan", input: { files: [{ path: "proj/a.jsonl", bytes: text.length, hash: h }] } });
  assert.ok(!plan.result.error, JSON.stringify(plan.result.error));
  assert.deepEqual(plan.result.data.new, ["proj/a.jsonl"]);
  const start = await tool("link.remote").run({ tool: "sync.upload.start", input: { path: "proj/a.jsonl", bytes: text.length, hash: h } });
  assert.ok(start.result.data.upload, JSON.stringify(start.result));
  const chunk = await tool("link.upload").run({ upload: start.result.data.upload, offset: 0, data: Buffer.from(text) });
  assert.ok(chunk.offset === text.length || chunk.data, JSON.stringify(chunk));
  const fin = await tool("link.remote").run({ tool: "sync.upload.finish", input: { upload: start.result.data.upload, hash: h } });
  assert.ok(!fin.result.error, JSON.stringify(fin.result.error));
  const landed = path.join(root, "synced", "alex-pc", "proj", "a.jsonl");
  assert.equal(fs.readFileSync(landed, "utf8"), text);

  // Removing the app device stops the core at once, with nothing kept on the core.
  db.prepare("UPDATE relay_devices SET removed_at = ? WHERE id = ?").run(Date.now(), APP);
  const after = await tool("link.remote").run({ tool: "sync.upload.plan", input: { files: [] } });
  assert.ok(after.result.error, "refused once the app device is gone");
});
