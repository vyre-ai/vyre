// @ts-check
// The API-key chat drivers go through the kernel's inference door when the home has one: an owner's chat turn is scanned (a sealed-looking value reaches the model only as a placeholder), a launch with no person to
// act for is refused in words and sends nothing. Real daemon, kernel on, a fake OpenRouter on this machine. Run on a test box, never on a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { start, callerFacts } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("a chat turn on the owner's OpenRouter account goes through the door, a sealed-looking value is a placeholder at the model, and a launch with no person is refused", { timeout: 180_000 }, async t => {
  /** @type {any[]} */ const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { seen.push({ auth: req.headers.authorization, ...JSON.parse(b || "{}") }); res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answered" } }] })}\n\ndata: [DONE]\n\n`); res.end(); }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const saved = process.env.VYRE_OPENROUTER_URL;
  process.env.VYRE_OPENROUTER_URL = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
  delete process.env.VYRE_LEGACY_DIRECT_MODEL;
  t.after(() => { if (saved === undefined) delete process.env.VYRE_OPENROUTER_URL; else process.env.VYRE_OPENROUTER_URL = saved; });
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const owner = { kernelFacts: callerFacts("cli", {}, {}, K, false, null, { inside: false, outside: true }) };
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", owner);
  assert.ok((await as("vault.put", { name: "or-key", kind: "api-key", value: "sk-or-v1-" + "a".repeat(40), grants: ["threads"] })).data, "the key is in the Vault");
  const acct = await as("sessions.accounts.add", { provider: "openrouter", label: "OpenRouter", kind: "api-key", vault_item: "or-key", model: "x/y" });
  assert.equal(acct.error, undefined, JSON.stringify(acct.error));
  assert.ok(K.gateway.model, "this home has the inference door");
  const chat = await K.gateway.grants.chats.create(ownerChain, {});
  const SSN = "123-45-6789";
  // the stream starts a chat turn: chat and asker come only from module:stream
  const th = await d.registry.call("threads.start", { cwd: process.cwd(), provider: "openrouter", model: "x/y", prompt: `my number is ${SSN}, say ok`, chat: chat.id, asker: OWNER, surface: "deck" }, "module:stream");
  assert.equal(th.error, undefined, JSON.stringify(th.error));
  await until(async () => seen.length >= 1, "the model to be asked");
  assert.equal(seen[0].auth, "Bearer sk-or-v1-" + "a".repeat(40), "the account's own key");
  assert.ok(!JSON.stringify(seen[0].messages).includes(SSN), `the door's scan: a sealed-looking value did not reach the model: ${JSON.stringify(seen[0].messages).slice(0, 300)}`);
  // a launch with nobody to act for goes nowhere: refused in words, nothing sent
  const before = seen.length;
  const none = await d.registry.call("threads.launch", { cwd: process.cwd(), provider: "openrouter", model: "x/y", prompt: "hello", surface: "deck" }, "module:agents");
  if (!none.error) {
    const id = none.data.id;
    const ended = await until(async () => { const r = await as("threads.get", { thread: id }); const ev = (r.data && r.data.events) || []; return ev.find(e => e.type === "thread.finished") || null; }, "the launch to end");
    assert.equal(ended.payload.ok, false); assert.match(String(ended.payload.error), /no person to act for/);
  }
  assert.equal(seen.length, before, "nothing was sent");
});
