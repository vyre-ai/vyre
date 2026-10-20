// One OpenCode key: checked on the regular models list, Go only recorded, then a thread on the product the account chose. The server is this test's. Nothing calls opencode.ai.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { boot } from "./testing/boot.js";

const KEY = "oc-test-key-0123456789abcdef";

/** A home with no inference door, so the legacy direct path is the one this thread uses. @param {any} t */
function noDoor(t) {
  const saved = process.env.VYRE_KERNEL_FILE_KEY;
  process.env.VYRE_KERNEL_FILE_KEY = "1";
  t.after(() => { if (saved === undefined) delete process.env.VYRE_KERNEL_FILE_KEY; else process.env.VYRE_KERNEL_FILE_KEY = saved; });
}

/** Point both OpenCode clients at this test's origin. A path on the env URL is ignored. @param {any} t @param {string} origin */
function useOrigin(t, origin) {
  const prev = { u: process.env.VYRE_OPENCODE_URL, g: process.env.VYRE_OPENCODE_GO_URL, d: process.env.VYRE_LEGACY_DIRECT_MODEL };
  process.env.VYRE_OPENCODE_URL = origin;
  process.env.VYRE_OPENCODE_GO_URL = origin;
  process.env.VYRE_LEGACY_DIRECT_MODEL = "1";
  t.after(() => {
    for (const [name, was] of [["VYRE_OPENCODE_URL", prev.u], ["VYRE_OPENCODE_GO_URL", prev.g], ["VYRE_LEGACY_DIRECT_MODEL", prev.d]]) {
      if (was === undefined) delete process.env[name]; else process.env[name] = was;
    }
  });
}

/** @param {any} t @param {"both" | "deny" | "nogo"} mode */
async function service(t, mode) {
  /** @type {{ method: string, url: string, auth: boolean, ua: string, session: string }[]} */
  const seen = [];
  const srv = http.createServer((req, res) => {
    const url = String(req.url || "");
    const auth = req.headers.authorization === `Bearer ${KEY}`;
    seen.push({ method: String(req.method), url, auth, ua: String(req.headers["user-agent"] || ""), session: String(req.headers["x-opencode-session"] || "") });
    const models = url === "/inference/v1/models" || url === "/inference/go/v1/models";
    if (req.method === "GET" && models) {
      if (mode === "deny" && url === "/inference/v1/models") { res.writeHead(401); return res.end("no"); }
      if (mode === "nogo" && url === "/inference/go/v1/models") { res.writeHead(404); return res.end("no"); }
      res.writeHead(auth ? 200 : 401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "glm-5.3" }, { id: "jev-1.13" }] }));
    }
    if (req.method === "POST" && (url === "/inference/openai/v1/chat/completions" || url === "/inference/go/openai/v1/chat/completions")) {
      if (!auth) { res.writeHead(401); return res.end("no"); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { content: "echo hello" } }] }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); }));
  const port = /** @type {any} */ (srv.address()).port;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

test("one OpenCode key is stored, Go is recorded, and neither the answer nor the Vault shows the key", async (t) => {
  noDoor(t);
  const s = await service(t, "both");
  useOrigin(t, s.origin);
  const w = await boot(t, { driver: "cli", vault: { "seed-item": "seed-value" } });
  const r = await w.tool("sessions.accounts.key", { kind: "opencode", key: KEY, model: "glm-5.3", label: "OpenCode" });
  assert.equal(r.error, undefined, JSON.stringify(r.error || {}));
  assert.equal(r.data.go_ok, true);
  assert.equal(r.data.provider, "opencode");
  assert.equal(JSON.stringify(r).includes(KEY), false);
  const rows = (await w.tool("sessions.accounts.list", { provider: "opencode" })).data;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].go_ok, true);
  assert.equal(rows[0].go_only, false);
  assert.equal(JSON.stringify(rows).includes(KEY), false);
  const items = (await w.tool("vault.list", {})).data.items;
  assert.equal(JSON.stringify(items).includes(KEY), false);
  const item = items.find((/** @type {any} */ x) => x.name === rows[0].vault_item);
  assert.deepEqual(item.hosts, ["https://opencode.ai"]);
  const gets = s.seen.filter((x) => x.method === "GET");
  assert.ok(gets.some((x) => x.url === "/inference/v1/models" && x.auth && x.ua.startsWith("vyre/")));
  assert.ok(gets.some((x) => x.url === "/inference/go/v1/models" && x.auth && x.ua.startsWith("vyre/")));
  assert.equal(gets.some((x) => x.session), false, "a model list does not send a session");
});

test("a regular OpenCode thread uses the inference chat path and no session header", async (t) => {
  noDoor(t);
  const s = await service(t, "both");
  useOrigin(t, s.origin);
  const w = await boot(t, { driver: "cli" });
  const r = await w.tool("sessions.accounts.key", { kind: "opencode", key: KEY, model: "glm-5.3", label: "OpenCode" });
  assert.equal(r.error, undefined, JSON.stringify(r.error || {}));
  const id = (await w.tool("sessions.accounts.list", { provider: "opencode" })).data[0].id;
  const th = (await w.tool("threads.start", { cwd: w.work, provider: "opencode", account: id, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  const text = (await w.events(th.id)).filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload.done).map((/** @type {any} */ e) => e.payload.text).join(" ");
  assert.match(text, /echo hello/);
  const post = s.seen.filter((x) => x.method === "POST");
  assert.equal(post.length, 1);
  assert.equal(post[0].url, "/inference/openai/v1/chat/completions");
  assert.equal(post[0].auth, true);
  assert.equal(post[0].session, "");
  assert.match(post[0].ua, /^vyre\//);
});

test("Only use OpenCode Go sends the thread id on the Go chat path", async (t) => {
  noDoor(t);
  const s = await service(t, "both");
  useOrigin(t, s.origin);
  const w = await boot(t, { driver: "cli" });
  const added = await w.tool("sessions.accounts.key", { kind: "opencode", key: KEY, model: "glm-5.3", label: "OpenCode" });
  assert.equal(added.error, undefined, JSON.stringify(added.error || {}));
  const id = (await w.tool("sessions.accounts.list", { provider: "opencode" })).data[0].id;
  const set = await w.tool("sessions.accounts.set", { account: id, go_only: true });
  assert.equal(set.error, undefined, JSON.stringify(set.error || {}));
  assert.equal(set.data.go_only, true);
  const th = (await w.tool("threads.start", { cwd: w.work, provider: "opencode", account: id, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  const post = s.seen.filter((x) => x.method === "POST");
  assert.equal(post.length, 1);
  assert.equal(post[0].url, "/inference/go/openai/v1/chat/completions");
  assert.equal(post[0].session, th.id);
  assert.match(post[0].ua, /^vyre\//);
});

test("a refused regular models list stores nothing", async (t) => {
  const s = await service(t, "deny");
  useOrigin(t, s.origin);
  const w = await boot(t, { driver: "cli" });
  const r = await w.tool("sessions.accounts.key", { kind: "opencode", key: KEY, label: "OpenCode" });
  assert.match(r.error.message, /refused that key/);
  assert.equal(r.error.message.includes(KEY), false);
  assert.equal((await w.tool("sessions.accounts.list", { provider: "opencode" })).data.length, 0);
  assert.equal(s.seen.some((x) => x.url.includes("/inference/go/")), false);
});

test("OpenCode refuses a base address before any request", async (t) => {
  const s = await service(t, "both");
  useOrigin(t, s.origin);
  const w = await boot(t, { driver: "cli" });
  const r = await w.tool("sessions.accounts.key", { kind: "opencode", key: KEY, base_url: "https://opencode.ai", label: "OpenCode" });
  assert.equal(r.error.code, "bad_input");
  assert.match(r.error.message, /one address/);
  assert.equal(s.seen.length, 0);
});

test("Go missing still stores the key and will not turn Go on", async (t) => {
  const s = await service(t, "nogo");
  useOrigin(t, s.origin);
  const w = await boot(t, { driver: "cli" });
  const r = await w.tool("sessions.accounts.key", { kind: "opencode", key: KEY, model: "glm-5.3", label: "OpenCode" });
  assert.equal(r.error, undefined, JSON.stringify(r.error || {}));
  assert.equal(r.data.go_ok, false);
  const row = (await w.tool("sessions.accounts.list", { provider: "opencode" })).data[0];
  assert.equal(row.go_ok, false);
  assert.equal(row.go_only, false);
  const set = await w.tool("sessions.accounts.set", { account: row.id, go_only: true });
  assert.equal(set.error.code, "bad_input");
  assert.match(set.error.message, /not on this key/);
  assert.equal((await w.tool("sessions.accounts.list", { provider: "opencode" })).data[0].go_only, false);
});
