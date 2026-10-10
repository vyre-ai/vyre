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

test("openrouter: it asks not to be trained on, needs a chosen model and an https address, cuts a huge answer, and ends a stalled one", async t => {
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
  assert.match((await turn(openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: s.url }), {})).result, /choose a model/);
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

test("openrouter: a picture rides the turn as an image_url part, and the kept history holds a note, not the bytes", async t => {
  const s = await server(t);
  const p = openrouterProvider({ legacyDirect: true, warn() {}, baseUrl: s.url });
  const id = crypto.randomUUID(), got = [];
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  const a = p.run({ id, resume: false, model: "x/y", env: { OPENROUTER_API_KEY: "sk-test" }, onMessage: m => got.push(m), onExit() {}, onSpawn() {} });
  a.write({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }, { type: "text", text: "what is this" }] } });
  for (let i = 0; i < 100 && !got.some(m => m.type === "result"); i++) await new Promise(r => setTimeout(r, 20));
  const sent = s.seen.at(-1).messages.at(-1).content;
  assert.deepEqual(sent, [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }]);
  a.write({ type: "user", message: { role: "user", content: "and now words only" } });
  for (let i = 0; i < 100 && got.filter(m => m.type === "result").length < 2; i++) await new Promise(r => setTimeout(r, 20));
  const again = s.seen.at(-1).messages;
  assert.ok(!JSON.stringify(again).includes(png), "the bytes are not sent again");
  assert.match(again.find(m => m.role === "user").content, /what is this\n\[an image was shown with this message\]/);
  await a.stop();
});
