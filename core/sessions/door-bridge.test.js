// @ts-check
// The inference door in front of sessions: the API-key chat driver calls door.call, a process driver has its prompt and its reports
// sanitised, no door means no model call unless legacyDirect is on, and a refusal reads in plain words with no value in it.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openrouterProvider, openrouterDoorDriver } from "./drivers/openrouter.js";
import { throughDoor, route, doorMessage, _resetWarned } from "../../lib/door-bridge.js";

const CHAIN = { space: "spc_aaaaaaaaaaaa", hops: [{ actor: { kind: "person", id: "per_a", space: "spc_aaaaaaaaaaaa" } }] };
const SECRET = "123-45-6789";

/** A fake door: records calls, refuses a prompt that holds the secret like the ledger would, sanitises by replacing it. */
function fakeDoor(over = {}) {
  const calls = [];
  return Object.assign({
    calls,
    async call(input) {
      calls.push(input);
      if (input.messages.some(m => m.content.includes(SECRET))) { const e = Object.assign(new Error("ledger_hit"), { code: "ledger_hit", refusal: { code: "ledger_hit", class: "ssn" } }); throw e; }
      return { id: "x", provider: input.provider, model: input.model, content: "echo: " + input.messages.at(-1).content, usage: { input_tokens: 4, output_tokens: 2, cost_usd: 0.001 } };
    },
    async sanitize({ text }) { return text.split(SECRET).join("[ssn]"); },
    async result({ text }) { return text.split(SECRET).join("[ssn]"); },
  }, over);
}

/** Run one turn on a provider and collect what it reports. */
function turn(provider, o, prompt) {
  return new Promise(resolve => {
    const got = [];
    const h = provider.run({ id: "thr_1", resume: false, cwd: "/", env: { OPENROUTER_API_KEY: "sk-test" }, model: "x/y", chain: CHAIN, onSpawn() {}, onExit() {}, onMessage: m => { got.push(m); if (m.type === "result") resolve({ got, h }); }, ...o });
    h.write({ type: "user", message: { role: "user", content: prompt } });
  });
}

test("chat driver: a turn goes through door.call with purpose session, the thread as session, and the key only in credential", async () => {
  const door = fakeDoor();
  const { got } = await turn(openrouterProvider({ door }), {}, "hello");
  assert.equal(door.calls.length, 1);
  const c = door.calls[0];
  assert.equal(c.purpose, "session"); assert.equal(c.session, "thr_1"); assert.equal(c.provider, "openrouter"); assert.equal(c.model, "x/y");
  assert.equal(c.chain, CHAIN);
  assert.ok(!JSON.stringify(c.messages).includes("sk-test"), "the key is not in the prompt");
  assert.equal(got.find(m => m.type === "result").result, "echo: hello");
  assert.ok(got.some(m => m.type === "stream_event"), "the whole answer arrives as one chunk");
});

test("chat driver: a ledger refusal reads in plain words and carries no value", async () => {
  const { got } = await turn(openrouterProvider({ door: fakeDoor() }), {}, `my number is ${SECRET}`);
  const r = got.find(m => m.type === "result");
  assert.equal(r.is_error, true);
  assert.match(r.result, /sealed/);
  assert.ok(!r.result.includes(SECRET));
});

test("chat driver: with no door it refuses and sends nothing; legacyDirect keeps today's path and warns once", async () => {
  _resetWarned();
  const { got } = await turn(openrouterProvider({}), {}, "hi");
  assert.match(got.find(m => m.type === "result").result, /inference door/);
  const warns = [];
  const calls = [];
  const fetch = async (u, i) => { calls.push(u); return { ok: true, body: (async function* () { yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'); })() }; };
  const p = openrouterProvider({ legacyDirect: true, warn: m => warns.push(m), fetch, baseUrl: "http://127.0.0.1:9" });
  await turn(p, {}, "a"); await turn(p, { id: "thr_2" }, "b");
  assert.equal(calls.length, 2);
  assert.equal(warns.length, 1, "one warning per provider");
});

test("door driver: makes one non-streamed call with the key from credential and never leaks it in an error", async () => {
  const seen = [];
  const fetch = async (u, i) => { seen.push({ u, auth: i.headers.authorization, body: JSON.parse(i.body) }); return { ok: false, status: 500, text: async () => "boom sk-test" }; };
  const d = openrouterDoorDriver({ fetch, baseUrl: "http://127.0.0.1:9" });
  await assert.rejects(() => d.call({ model: "m", messages: [{ role: "user", content: "x" }], credential: { key: "sk-test" } }), e => !e.message.includes("sk-test") && /500/.test(e.message));
  assert.equal(seen[0].auth, "Bearer sk-test"); assert.equal(seen[0].body.stream, false);
  const ok = openrouterDoorDriver({ fetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "yo" } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }) }), baseUrl: "http://127.0.0.1:9" });
  assert.deepEqual(await ok.call({ model: "m", messages: [], credential: { key: "k" } }), { content: "yo", usage: { input_tokens: 1, output_tokens: 2, cost_usd: 0 } });
});

/** A process provider double: reports what it was written and answers with a secret in its text. */
function procProvider() {
  const written = [];
  return { written, id: "codex", run(o) {
    o.onMessage({ type: "system", subtype: "init", session_id: o.id });
    return { pid: 1, alive: true, write(m) { written.push(m); o.onMessage({ type: "assistant", message: { id: "a", content: [{ type: "text", text: `ssn ${SECRET}` }, { type: "tool_use", id: "t", name: "Bash", input: { command: `echo ${SECRET}` } }] } }); o.onMessage({ type: "result", is_error: false, result: `done ${SECRET}` }); }, stop: async () => {}, interrupt: async () => {} };
  } };
}

test("process driver: the prompt is sanitised on the way in and every report on the way out", async () => {
  const inner = procProvider();
  const p = throughDoor(inner, { door: fakeDoor() });
  const got = [];
  const h = p.run({ id: "thr_9", chain: CHAIN, onMessage: m => got.push(m), onExit() {} });
  h.write({ type: "user", message: { role: "user", content: `use ${SECRET}` } });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(inner.written[0].message.content, "use [ssn]");
  assert.ok(!JSON.stringify(got).includes(SECRET), "nothing persisted or shown holds the value");
  assert.deepEqual(got.map(m => m.type), ["system", "assistant", "result"], "order is kept");
});

test("process driver: with no door it reports a refusal and starts nothing; a door that throws is reported in plain words", async () => {
  const inner = procProvider();
  const got = [];
  throughDoor(inner, {}).run({ id: "t", onMessage: m => got.push(m), onExit() {} });
  await new Promise(r => setTimeout(r, 5));
  assert.match(got[0].result, /inference door/); assert.equal(inner.written.length, 0);
  const got2 = [];
  const bad = fakeDoor({ sanitize: async () => { throw Object.assign(new Error("x"), { refusal: { code: "budget", meter: "scan" } }); } });
  const h = throughDoor(inner, { door: bad }).run({ id: "t2", chain: CHAIN, onMessage: m => got2.push(m), onExit() {} });
  h.write({ type: "user", message: { role: "user", content: "hi" } });
  await new Promise(r => setTimeout(r, 20));
  assert.match(got2.at(-1).result, /limit/); assert.equal(inner.written.length, 0, "a prompt the door could not check is not sent");
});

test("doorMessage: each refusal has plain words and none echoes a class's content", () => {
  for (const code of ["ledger_hit", "residency", "not_a_sink", "budget"]) assert.ok(doorMessage({ refusal: { code, class: "ssn", detail: SECRET } }) && !doorMessage({ refusal: { code } }).includes(SECRET));
  assert.equal(doorMessage(new Error("other")), null);
  assert.deepEqual(route({}, "x"), { refused: route({}, "x").refused });
});
