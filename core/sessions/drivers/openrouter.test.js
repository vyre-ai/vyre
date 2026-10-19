// @ts-check
// The OpenRouter driver against a local OpenAI-compatible server: conform() (no process, no tools),
// the key, history across a resume, and a limit said as one.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { openrouterProvider } from "./openrouter.js";
import { conform } from "../conformance.js";

/** A server that answers like /chat/completions: echoes the last user text, "slow" streams for seconds, "limit" is a 429. */
async function server(t) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      const j = JSON.parse(body || "{}");
      seen.push({ auth: req.headers.authorization, model: j.model, messages: j.messages, provider: j.provider });
      const last = j.messages.at(-1).content;
      if (req.headers.authorization !== "Bearer sk-test") { res.writeHead(401); return res.end("no key"); }
      if (/^limit/.test(last)) { res.writeHead(429); return res.end("rate limit exceeded"); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const words = /^slow/.test(last) ? Array.from({ length: 60 }, () => "word ") : [`echo: ${last}`];
      let i = 0;
      const tick = () => {
        if (res.destroyed) return;
        if (i < words.length) { send({ choices: [{ delta: { content: words[i++] } }] }); return void setTimeout(tick, /^slow/.test(last) ? 100 : 0); }
        send({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3, cost: 0.0001 } });
        res.write("data: [DONE]\n\n"); res.end();
      };
      tick();
    });
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r(undefined)); }));
  return { url: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`, seen };
}

test("openrouter: conform() passes with no process and no tools; the stream, an interrupt of a slow turn, and a resume", async t => {
  const s = await server(t);
  const p = openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: s.url });
  const fails = await conform(p, { id: crypto.randomUUID(), cwd: "/tmp", env: { OPENROUTER_API_KEY: "sk-test" }, extra: { model: "x/y" } });
  assert.deepEqual(fails, []);
});

test("openrouter: the key is the account's, the model is the one asked for, a resume keeps the conversation, cost comes back", async t => {
  const s = await server(t);
  const p = openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: s.url });
  const id = crypto.randomUUID();
  const got = [];
  const run = resume => p.run({ id, resume, model: "anthropic/claude-haiku-4.5", system: { mode: "append", text: "Be brief." }, env: { OPENROUTER_API_KEY: "sk-test" }, onMessage: m => got.push(m), onExit() {} });
  const a = run(false);
  a.write({ type: "user", message: { role: "user", content: "first" } });
  for (let i = 0; i < 100 && !got.some(m => m.type === "result"); i++) await new Promise(r => setTimeout(r, 20));
  await a.stop();
  const b = run(true);
  b.write({ type: "user", message: { role: "user", content: "second" } });
  for (let i = 0; i < 100 && got.filter(m => m.type === "result").length < 2; i++) await new Promise(r => setTimeout(r, 20));
  await b.stop();
  assert.equal(s.seen[0].model, "anthropic/claude-haiku-4.5");
  assert.equal(s.seen[0].messages[0].content, "Be brief.");
  assert.deepEqual(s.seen[1].messages.map(m => m.content), ["Be brief.", "first", "echo: first", "second"], "the resumed turn carries the first exchange");
  assert.ok(Math.abs(got.filter(m => m.type === "result").at(-1).total_cost_usd - 0.0001) < 1e-9, "a run reports its own running total, as Claude Code does per process");
});

test("openrouter: a missing or wrong key, and a 429, end the turn as errors; a limit says so", async t => {
  const s = await server(t);
  const p = openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: s.url });
  const turn = async (env, text) => {
    const got = [];
    const r = p.run({ id: crypto.randomUUID(), resume: false, model: "x/y", env, onMessage: m => got.push(m), onExit() {} });
    r.write({ type: "user", message: { role: "user", content: text } });
    for (let i = 0; i < 100 && !got.some(m => m.type === "result"); i++) await new Promise(x => setTimeout(x, 20));
    await r.stop();
    return got.find(m => m.type === "result");
  };
  assert.match((await turn({}, "hi")).result, /no OpenRouter key/);
  assert.match((await turn({ OPENROUTER_API_KEY: "wrong" }, "hi")).result, /answered 401/);
  const limited = await turn({ OPENROUTER_API_KEY: "sk-test" }, "limit now");
  assert.equal(limited.is_error, true);
  assert.match(limited.result, /usage limit reached/);
});

test("openrouter: it asks not to be trained on, falls back to the default model, needs an https address, cuts a huge answer, and ends a stalled one", async t => {
  const s = await server(t);
  const turn = async (p, o) => {
    const got = [];
    const r = p.run({ id: crypto.randomUUID(), resume: false, env: { OPENROUTER_API_KEY: "sk-test" }, onMessage: m => got.push(m), onExit() {}, ...o });
    r.write({ type: "user", message: { role: "user", content: o.say || "hi" } });
    for (let i = 0; i < 150 && !got.some(m => m.type === "result"); i++) await new Promise(x => setTimeout(x, 20));
    await r.stop();
    return got.find(m => m.type === "result");
  };
  await turn(openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: s.url }), { model: "x/y" });
  assert.deepEqual(s.seen.at(-1).provider, { data_collection: "deny" });
  // no model at all: the default first run saves is used, never an empty model
  await turn(openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: s.url }), {});
  assert.equal(s.seen.at(-1).model, "anthropic/claude-sonnet-4.5");
  assert.match((await turn(openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: "http://example.com/v1" }), { model: "x/y" })).result, /must be https/);
  // A server that never stops talking is cut at the cap; one that goes quiet is ended.
  const http = await import("node:http");
  const big = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "text/event-stream" }); const t2 = setInterval(() => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(100_000) } }] })}\n\n`), 5); res.on("close", () => clearInterval(t2)); });
  await new Promise(r => big.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { big.closeAllConnections?.(); big.close(); });
  const cut = await turn(openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: `http://127.0.0.1:${/** @type {any} */ (big.address()).port}` }), { model: "x/y" });
  assert.match(cut.result, /1 MB/);
  const quiet = http.createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": hold\n\n"); });
  await new Promise(r => quiet.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { quiet.closeAllConnections?.(); quiet.close(); });
  const stalled = await turn(openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: `http://127.0.0.1:${/** @type {any} */ (quiet.address()).port}`, idleMs: 200 }), { model: "x/y" });
  assert.match(stalled.result, /stopped answering/);
});

test("conform: only Vyre's own openrouter driver may skip the process and tool checks", async () => {
  const p = openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: "http://127.0.0.1:1" });
  const fails = await conform({ ...p, id: "sneaky" }, { id: crypto.randomUUID(), cwd: "/tmp", env: { OPENROUTER_API_KEY: "sk-test" }, timeout: 500 });
  assert.ok(fails.length > 0, "a module's provider claiming process:false is checked in full");
});

// What a chat launch carries is not always an OpenRouter model: a Claude alias ("opus") is never sent to OpenRouter, and every shape of answer ends in words.
async function oneShot(t, handler) {
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { seen.push(JSON.parse(b || "{}")); handler(req, res, seen.at(-1)); }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
  const turn = async (o = {}) => {
    const got = [];
    const r = openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: base }).run({ id: crypto.randomUUID(), resume: false, env: { OPENROUTER_API_KEY: "sk-test" }, onMessage: m => got.push(m), onExit() {}, ...o });
    r.write({ type: "user", message: { role: "user", content: "hi" } });
    for (let i = 0; i < 150 && !got.some(m => m.type === "result"); i++) await new Promise(x => setTimeout(x, 20));
    await r.stop();
    return { result: got.find(m => m.type === "result"), said: got.filter(m => m.type === "stream_event" && m.event.delta).map(m => m.event.delta.text).join("") };
  };
  return { seen, turn };
}
const sse = (res, text) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`); res.end(); };

test("openrouter: a Claude alias in the launch's model is never sent; the account's model, else the default, is", async t => {
  const { seen, turn } = await oneShot(t, (req, res) => sse(res, "ok"));
  await turn({ model: "opus" });
  assert.equal(seen.at(-1).model, "anthropic/claude-sonnet-4.5", "alias, no account model: the default");
  await turn({ model: "opus", env: { OPENROUTER_API_KEY: "sk-test", VYRE_API_MODEL: "openai/gpt-4o-mini" } });
  assert.equal(seen.at(-1).model, "openai/gpt-4o-mini", "alias: the account's own model");
  await turn({ model: "anthropic/claude-haiku-4.5", env: { OPENROUTER_API_KEY: "sk-test", VYRE_API_MODEL: "openai/gpt-4o-mini" } });
  assert.equal(seen.at(-1).model, "anthropic/claude-haiku-4.5", "an OpenRouter id the launch names stands");
});

test("openrouter: a 400 from the service, a plain JSON answer, an error sent with a 200 and an empty answer each end the turn in words", async t => {
  let mode = "400";
  const { turn } = await oneShot(t, (req, res) => {
    if (mode === "400") { res.writeHead(400); return res.end('{"error":{"message":"opus is not a valid model ID"}}'); }
    if (mode === "json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { content: "plain answer" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } })); }
    if (mode === "error200") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "no credits for sk-test" } })); }
    if (mode === "comments") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": keep-alive\n\n"); return res.end(); }
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: [DONE]\n\n"); res.end();
  });
  let r = await turn({ model: "x/y" });
  assert.equal(r.result.is_error, true); assert.match(r.result.result, /OpenRouter answered 400: .*not a valid model/);
  mode = "json"; r = await turn({ model: "x/y" });
  assert.equal(r.result.is_error, false); assert.equal(r.said, "plain answer"); assert.equal(r.result.result, "plain answer");
  mode = "error200"; r = await turn({ model: "x/y" });
  assert.equal(r.result.is_error, true); assert.match(r.result.result, /no credits for \[key\]/, "the key is scrubbed from the words");
  for (const m of ["comments", "done"]) { mode = m; r = await turn({ model: "x/y" }); assert.equal(r.result.is_error, true, m); assert.match(r.result.result, /returned no answer/, m); }
});

test("openrouter, a fresh box with no inference door: the owner's own API-key account is sent direct with the prompt scrubbed; any other run is refused; a connected door is used first", async t => {
  const KEY = "sk-or-v1-" + "a".repeat(40);
  const run = async (entry, env, say = `please use ${KEY}`) => {
    const got = [];
    const srv = http.createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { entry.seen.push(JSON.parse(b || "{}")); sse(res, "hello"); }); });
    await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
    t.after(() => { srv.closeAllConnections?.(); srv.close(); });
    const p = openrouterProvider({ baseUrl: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`, warn() {}, ...(entry.door ? { door: entry.door } : {}) });
    const r = p.run({ id: crypto.randomUUID(), resume: false, model: "x/y", env: { OPENROUTER_API_KEY: "sk-test", ...env }, onMessage: m => got.push(m), onExit() {} });
    r.write({ type: "user", message: { role: "user", content: say } });
    for (let i = 0; i < 150 && !got.some(m => m.type === "result"); i++) await new Promise(x => setTimeout(x, 20));
    await r.stop();
    return got.find(m => m.type === "result");
  };
  // the owner's own account, no door: sent, and the credential in the prompt is not
  const direct = { seen: [] };
  const ok = await run(direct, { VYRE_OWNER_ACCOUNT: "1" });
  assert.equal(ok.is_error, false);
  assert.equal(direct.seen.length, 1, "the request was sent");
  assert.ok(!JSON.stringify(direct.seen[0].messages).includes(KEY), "the prompt left without the key");
  // anyone else's run, no door: refused in words, nothing sent
  const refused = { seen: [] };
  const no = await run(refused, {});
  assert.equal(no.is_error, true);
  assert.match(no.result, /inference door and none is connected/);
  assert.equal(refused.seen.length, 0, "nothing was sent");
  // a door that is connected is used first, even for the owner's account
  let doorCalled = 0;
  const withDoor = { seen: [], door: { call: async () => { doorCalled++; return { content: "via the door" }; } } };
  const via = await run(withDoor, { VYRE_OWNER_ACCOUNT: "1" });
  assert.equal(via.is_error, false);
  assert.equal(doorCalled, 1);
  assert.equal(withDoor.seen.length, 0, "the door answered; no direct request");
});

test("openrouter: one reply is one message: the stream's message_start, its text and the finished message share one id and block, so a thread draws one bubble", async t => {
  const { translate } = await import("../../switchboard/translate.js");
  const s = await server(t);
  const p = openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: s.url });
  const got = [];
  const r = p.run({ id: crypto.randomUUID(), resume: false, model: "x/y", env: { OPENROUTER_API_KEY: "sk-test" }, onMessage: m => got.push(m), onExit() {} });
  for (const text of ["first", "second"]) {
    const before = got.filter(m => m.type === "result").length;
    r.write({ type: "user", message: { role: "user", content: text } });
    for (let i = 0; i < 150 && got.filter(m => m.type === "result").length === before; i++) await new Promise(x => setTimeout(x, 20));
  }
  await r.stop();
  // what the Switchboard makes of it: the id the stream announced is the id of the finished text, block 0 in both
  let current = null;
  const seen = [];
  for (const m of got) {
    const x = translate(m);
    if (x.message) current = x.message;
    if (x.delta) seen.push({ kind: "delta", message: current, block: x.block });
    for (const e of x.events) if (e.type === "thread.text" && e.payload.done) seen.push({ kind: "done", message: e.payload.message, block: e.payload.block });
  }
  assert.deepEqual(seen.map(x => x.kind), ["delta", "done", "delta", "done"]);
  assert.equal(seen[0].message, seen[1].message); assert.equal(seen[0].block, seen[1].block);
  assert.equal(seen[2].message, seen[3].message); assert.notEqual(seen[0].message, seen[2].message, "the second reply is its own message");
});
