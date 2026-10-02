// "Sign in to your AI" with an API key: three kinds, a cheap check, the Vault, an account bound to its address, and a thread that sends the key only there.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { boot } from "./testing/boot.js";

const GOOD = "sk-test-key-1234567890abcdef";

/** A service: GET /v1/models (and OpenRouter-style /v1/auth/key) check the key; POST /v1/chat/completions streams an echo and says which key it saw. */
async function service(t) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      const auth = req.headers.authorization === `Bearer ${GOOD}` || req.headers["x-api-key"] === GOOD;
      seen.push({ method: req.method, url: req.url, auth, anthropic: req.headers["anthropic-version"] || null });
      if (req.method === "GET" && /\/models$/.test(req.url)) { res.writeHead(auth ? 200 : 401, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [] })); }
      if (req.method === "POST" && /\/chat\/completions$/.test(req.url)) {
        const j = JSON.parse(body || "{}");
        if (!auth) { res.writeHead(401); return res.end("no"); }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `echo ${j.model}: ${j.messages.at(-1).content}` } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 2, completion_tokens: 2, cost: 0 } })}\n\ndata: [DONE]\n\n`);
        return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); }));
  return { base: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`, seen };
}

test("api key: an OpenAI-compatible key is checked, vaulted, bound to its address, never returned, and a thread on it sends the key only there", async t => {
  const w = await boot(t, { driver: "cli", vault: { "seed-item": "seed-value" } });
  const s = await service(t);
  const r = await w.tool("sessions.accounts.key", { kind: "openai-compatible", key: GOOD, base_url: `${s.base}/v1`, model: "m1", label: "My lab server" });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual([r.data.provider, r.data.label, r.data.checked, r.data.model], ["openai-compatible", "My lab server", true, "m1"]);
  assert.ok(!JSON.stringify(r).includes(GOOD), "the key is never in the answer");
  assert.ok(s.seen.some(x => x.method === "GET" && x.url === "/v1/models" && x.auth), "one cheap check, with the key, at the address");
  assert.ok(!s.seen.some(x => x.method === "POST"), "the check ran no model");
  const rows = (await w.tool("sessions.accounts.list", { provider: "openai-compatible" })).data;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].kind, rows[0].base_url, rows[0].model, rows[0].pending], ["api-key", `${s.base}/v1`, "m1", false]);
  assert.ok(!JSON.stringify(rows).includes(GOOD));
  assert.match(rows[0].vault_item, /^ai-key-openai-compatible-[0-9a-f]{12}$/);
  const th = (await w.tool("threads.start", { cwd: w.work, provider: "openai-compatible", account: rows[0].id, prompt: "hello", surface: "deck" })).data;
  await w.finished(th.id);
  const text = (await w.events(th.id)).filter(e => e.type === "thread.text" && e.payload.done).map(e => e.payload.text).join(" ");
  assert.match(text, /echo m1: hello/, "the thread answered through the account's address and model");
  assert.ok(s.seen.some(x => x.method === "POST" && x.auth), "the key reached the chat call");
});

test("api key: a wrong key, an unsafe address, a bad shape, an agent and OpenRouter with an address are all refused, and nothing is stored", async t => {
  const w = await boot(t, { driver: "cli", vault: { "seed-item": "seed-value" } });
  const s = await service(t);
  const add = (input, caller = "cli") => w.d.registry.call("sessions.accounts.key", input, caller, {});
  const none = async () => (await w.tool("sessions.accounts.list", {})).data.filter(a => a.kind === "api-key").length;
  assert.match((await w.tool("sessions.accounts.key", { kind: "openai-compatible", key: "sk-wrong-key-1234567890", base_url: `${s.base}/v1` })).error.message, /refused that key/);
  for (const bad of ["http://example.com/v1", "https://user:pw@example.com/v1", "https://example.com/v1?x=1", "https://169.254.169.254/latest", "ftp://example.com", "not a url"]) {
    assert.equal((await w.tool("sessions.accounts.key", { kind: "openai-compatible", key: GOOD, base_url: bad })).error.code, "bad_input", bad);
  }
  for (const key of ["short", `${GOOD} extra`, `${GOOD}\nmore`, "x".repeat(401)]) assert.equal((await w.tool("sessions.accounts.key", { kind: "openai-compatible", key, base_url: `${s.base}/v1` })).error.code, "bad_input", JSON.stringify(key).slice(0, 20));
  assert.equal((await w.tool("sessions.accounts.key", { kind: "openrouter", key: GOOD, base_url: `${s.base}/v1` })).error.code, "bad_input", "OpenRouter has one address");
  assert.equal((await w.tool("sessions.accounts.key", { kind: "nope", key: GOOD })).error.code, "bad_input");
  const asAgent = await add({ kind: "openai-compatible", key: GOOD, base_url: `${s.base}/v1` }, "mcp:agent:juno");
  assert.ok(asAgent.error, "an agent never adds a key");
  assert.equal(await none(), 0, "nothing was stored");
});

test("api key: an Anthropic-compatible key is checked the way that service reads keys and becomes a Claude account at its address", async t => {
  const w = await boot(t, { driver: "cli", vault: { "seed-item": "seed-value" } });
  const s = await service(t);
  const r = await w.tool("sessions.accounts.key", { kind: "anthropic-compatible", key: GOOD, base_url: s.base });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.data.provider, "claude");
  assert.ok(s.seen.some(x => x.url === "/v1/models" && x.auth && x.anthropic === "2023-06-01"), "x-api-key and the version header at /v1/models");
  const row = (await w.tool("sessions.accounts.list", { provider: "claude" })).data.find(a => a.id === r.data.account);
  assert.deepEqual([row.kind, row.base_url], ["api-key", s.base]);
});
