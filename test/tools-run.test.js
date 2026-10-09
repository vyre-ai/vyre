// @ts-check
// tools_run (R031-00o: many steps in one call) and results by reference (R031-00p), and the safety claims they rest on:
//   - a step is judged exactly as if the agent had sent it alone (each step is its own POST to the tool door, same caller, same call id), so the same grants, reach, presence rules and Gate apply;
//   - a held step ends the script; a refused or failed one ends it; the answer says which steps ran;
//   - a handle belongs to the identity that made the call, is gone after a restart and after its time, and a slice is never again a large result;
//   - a batch cannot run a batch, and cannot wait on another session.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import * as batch from "../lib/batch.js";
import { createStore, summarize, costOf, LIMITS } from "../lib/results-store.js";
import { listing, catalogOf, META_TOOLS } from "../harness/mcp/core-tools.js";
import { tokens } from "../lib/tokens.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "mcp", "server.js");

// ---------------------------------------------------------------- the script runner, with a stand-in for the tool door

/** A host whose tools are given as functions; records every call it is asked to make. */
function host(/** @type {Record<string, (input: any) => any>} */ tools, extra = {}) {
  /** @type {{ name: string, input: any }[]} */ const calls = [];
  return { calls, call: async (/** @type {string} */ name, /** @type {any} */ input) => { calls.push({ name, input }); const f = tools[name]; return f ? f(input) : { error: { code: "no_such_tool", message: name } }; }, ...extra };
}
const known = (/** @type {string[]} */ ...names) => ({ known: (/** @type {string} */ n) => (names.includes(n) ? n : null) });

test("a chain: a later step reads an earlier result by expression, and return shapes the one answer", async () => {
  const h = host({
    "client.find": () => ({ data: { rows: [{ id: "c_1", name: "Dana Whitfield" }] } }),
    "matter.find": (i) => ({ data: { rows: i.client === "c_1" ? [{ title: "Estate", stage: "Open" }, { title: "Old", stage: "Closed" }] : [] } }),
  });
  const script = { steps: [
    { id: "c", call: "client.find", input: { q: "Whitfield" } },
    { id: "m", call: "matter.find", when: "len(steps.c.rows) > 0", input: { client: { expr: "steps.c.rows[0].id" } } },
  ], return: { client: { expr: "steps.c.rows[0].name" }, count: { expr: "len(steps.m.rows)" } } };
  assert.deepEqual(batch.check(script, known("client.find", "matter.find")), []);
  const r = await batch.run(script, h);
  assert.equal(r.status, "done");
  assert.deepEqual(r.ran, ["c", "m"]);
  assert.deepEqual(r.ret, { client: "Dana Whitfield", count: 2 });
  assert.deepEqual(h.calls[1].input, { client: "c_1" });
});

test("a step whose when is false is skipped, and says so", async () => {
  const h = host({ "a.x": () => ({ data: { rows: [] } }), "b.y": () => ({ data: 1 }) });
  const r = await batch.run({ steps: [{ id: "a", call: "a.x" }, { id: "b", call: "b.y", when: "len(steps.a.rows) > 0" }] }, h);
  assert.equal(r.status, "done");
  assert.deepEqual([r.ran, r.skipped], [["a"], ["b"]]);
  assert.equal(h.calls.length, 1);
});

test("a held step ends the script: later steps do not run, and the answer names the step and the held id", async () => {
  const h = host({ "a.x": () => ({ data: 1 }), "mail.send": () => ({ data: { id: "g_77", state: "held", message: "Held at the Gate" } }), "z.after": () => ({ data: 2 }) });
  const r = await batch.run({ steps: [{ id: "a", call: "a.x" }, { id: "send", call: "mail.send", input: { to: "x@y.z" } }, { id: "after", call: "z.after" }] }, h);
  assert.equal(r.status, "held");
  assert.deepEqual(r.ran, ["a", "send"]);
  assert.equal(r.stopped?.step, "send");
  assert.equal(r.stopped?.held, "g_77");
  assert.equal(h.calls.some((c) => c.name === "z.after"), false, "nothing ran past the hold");
  // the other held shapes (a kernel surface, the hub) end it too
  for (const data of [{ held: { task: "t_1", summary: "x" } }, { held: "g_9" }]) {
    const h2 = host({ "a.x": () => ({ data }), "z.after": () => ({ data: 2 }) });
    const r2 = await batch.run({ steps: [{ id: "a", call: "a.x" }, { id: "z", call: "z.after" }] }, h2);
    assert.equal(r2.status, "held");
    assert.equal(h2.calls.length, 1);
  }
});

test("a step the door refuses ends the script as refused (presence, denied, not found); any other failure is an error", async () => {
  for (const code of ["presence_required", "denied", "not_found", "no_such_tool", "person_session_required"]) {
    const h = host({ "a.x": () => ({ error: { code, message: "no" } }), "z.after": () => ({ data: 2 }) });
    const r = await batch.run({ steps: [{ id: "a", call: "a.x" }, { id: "z", call: "z.after" }] }, h);
    assert.equal(r.status, "refused", code);
    assert.equal(r.stopped?.code, code);
    assert.equal(h.calls.length, 1);
  }
  const h = host({ "a.x": () => ({ error: { code: "internal", message: "boom" } }) });
  assert.equal((await batch.run({ steps: [{ id: "a", call: "a.x" }] }, h)).status, "error");
});

test("a batch cannot run a batch, and cannot wait on another session", () => {
  for (const call of ["tools_run", "tools_call", "tools_find", "results_read", "threads_send", "threads.start", "agents_ask", "agents.ask"]) {
    const bad = batch.check({ steps: [{ id: "a", call }] }, { known: (n) => n });
    assert.ok(bad.some((p) => /cannot run inside tools_run/.test(p)), `${call}: ${bad}`);
  }
});

test("a script is checked whole before anything runs: shape, names, forward references and expressions", () => {
  const k = known("a.x", "b.y");
  assert.ok(batch.check({}, k).length);
  assert.ok(batch.check({ steps: [] }, k).length);
  assert.ok(batch.check({ steps: Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, call: "a.x" })) }, k).some((p) => /at most 20/.test(p)));
  assert.ok(batch.check({ steps: [{ id: "a", call: "a.x" }, { id: "a", call: "b.y" }] }, k).some((p) => /used twice/.test(p)));
  assert.ok(batch.check({ steps: [{ id: "a", call: "nope" }] }, k).some((p) => /no tool/.test(p)));
  assert.ok(batch.check({ steps: [{ id: "a", call: "a.x", input: { v: { expr: "steps.b.x" } } }, { id: "b", call: "b.y" }] }, k).some((p) => /not an earlier step/.test(p)), "a forward reference");
  assert.ok(batch.check({ steps: [{ id: "a", call: "a.x", input: { v: { expr: "eval(1)" } } }] }, k).length, "only the expression language's own functions");
  assert.ok(batch.check({ steps: [{ id: "a", call: "a.x", fn: "return {}" }] }, k).some((p) => /exactly one/.test(p)));
  assert.ok(batch.check({ steps: [{ id: "a", fn: "x".repeat(batch.LIMITS.source + 1) }] }, k).some((p) => /at most/.test(p)));
  assert.ok(batch.check({ steps: [{ id: "A-B", call: "a.x" }] }, k).some((p) => /id must be/.test(p)));
});

test("expressions are the Flows language: no eval, no regular expressions, no reaching the prototype", async () => {
  const h = host({ "a.x": () => ({ data: { v: 1 } }) });
  const k = known("a.x");
  for (const expr of ["steps.a.constructor", "steps.a.__proto__", "steps.a.prototype", "eval('1')", "steps.a.v.toString()", "/x/.test('x')"]) {
    assert.ok(batch.check({ steps: [{ id: "a", call: "a.x" }], return: { p: { expr } } }, k).length, `${expr} is refused before anything runs`);
  }
  const r = await batch.run({ steps: [{ id: "a", call: "a.x" }], return: { ok: { expr: "steps.a.v + 1" }, none: { expr: "steps.a.nothing.deeper" } } }, h);
  assert.deepEqual(r.ret, { ok: 2, none: null }, "a missing field is null, never a crash");
});

test("a step cannot change an earlier result: inputs are copies", async () => {
  const h = host({ "a.x": () => ({ data: { list: [1, 2] } }), "b.y": (i) => { i.list.push(99); return { data: i.list.length }; } });
  const r = await batch.run({ steps: [{ id: "a", call: "a.x" }, { id: "b", call: "b.y", input: { list: { expr: "steps.a.list" } } }], return: { a: { expr: "steps.a.list" }, b: { expr: "steps.b" } } }, h);
  assert.deepEqual(r.ret, { a: [1, 2], b: 3 });
});

test("the time limit ends the script at the step it reaches", async () => {
  let t = 0;
  const h = host({ "a.x": () => { t += 61_000; return { data: 1 }; }, "b.y": () => ({ data: 2 }) }, { now: () => t });
  const r = await batch.run({ steps: [{ id: "a", call: "a.x" }, { id: "b", call: "b.y" }] }, h);
  assert.equal(r.status, "error");
  assert.equal(r.stopped?.code, "timeout");
  assert.equal(r.stopped?.step, "b");
});

test("an fn step shapes data and is given only its inputs; with no sandbox the script says so", async () => {
  const seen = [];
  const fn = async (/** @type {any} */ req) => { seen.push(req); return { outputs: { open: req.inputs.m.rows.filter((/** @type {any} */ x) => x.stage !== "Closed").length } }; };
  const h = host({ "m.find": () => ({ data: { rows: [{ stage: "Open" }, { stage: "Closed" }] } }) }, { fn });
  const r = await batch.run({ steps: [{ id: "m", call: "m.find" }, { id: "s", fn: "return {}", inputs: { m: { expr: "steps.m" } } }], return: { open: { expr: "steps.s.open" } } }, h);
  assert.deepEqual(r.ret, { open: 1 });
  assert.deepEqual(seen[0].needs, [], "it asks for no power");
  assert.equal(seen[0].language, "js");
  const none = await batch.run({ steps: [{ id: "s", fn: "return {}" }] }, host({}));
  assert.equal(none.stopped?.code, "unavailable");
});

// ---------------------------------------------------------------- results by reference

const big = (/** @type {number} */ n) => ({ rows: Array.from({ length: n }, (_, i) => ({ id: `c_${i}`, name: `Client number ${i}`, note: "x".repeat(60) })), next_cursor: "abc" });

test("a small result is returned as it is; a large one becomes a handle and a deterministic summary", () => {
  const s = createStore();
  assert.deepEqual(s.shape("o", { a: 1 }), { value: { a: 1 } });
  const v = big(214);
  assert.ok(costOf(v) > LIMITS.threshold);
  const r = /** @type {any} */ (s.shape("o", v)).ref;
  assert.match(r.handle, /^r_[A-Za-z0-9_-]{22}$/, "128 bits");
  assert.equal(r.expires_in, 1800);
  assert.equal(r.summary.type, "object");
  assert.equal(r.summary.keys.rows, "array(214) of object");
  assert.equal(r.summary.head.in, "rows");
  assert.equal(r.summary.head.items.length, 3);
  assert.ok(tokens(JSON.stringify(r)) < 600, "the summary is small");
  assert.deepEqual(summarize(v), summarize(JSON.parse(JSON.stringify(v))), "deterministic");
  assert.equal(summarize("a".repeat(1000)).head.length, 300);
});

test("a handle is the identity's own: another owner is told not_found, in the same words as a handle that never was", () => {
  const s = createStore();
  const h = /** @type {any} */ (s.shape("alice", big(214))).ref.handle;
  const mine = /** @type {any} */ (s.read("alice", { handle: h, select: "rows[0].name" }));
  assert.equal(mine.data.value, "Client number 0");
  const other = /** @type {any} */ (s.read("bob", { handle: h }));
  const never = /** @type {any} */ (s.read("bob", { handle: "r_nothing" }));
  assert.deepEqual(other, never, "no sign that the handle exists");
  assert.equal(other.error.code, "not_found");
  assert.equal(s.drop("bob", h), false);
  assert.equal(s.drop("alice", h), true);
  assert.equal(/** @type {any} */ (s.read("alice", { handle: h })).error.code, "not_found");
});

test("a handle is gone after its time and after a restart; the store holds nothing on disk", () => {
  let t = 1000;
  const s = createStore({ now: () => t });
  const h = /** @type {any} */ (s.shape("o", big(214))).ref.handle;
  t += LIMITS.ttlMs - 1;
  assert.ok(/** @type {any} */ (s.read("o", { handle: h })).data);
  t += 2;
  assert.equal(/** @type {any} */ (s.read("o", { handle: h })).error.code, "not_found");
  const restarted = createStore();
  assert.equal(/** @type {any} */ (restarted.read("o", { handle: h })).error.code, "not_found");
  const src = fs.readFileSync(new URL("../lib/results-store.js", import.meta.url), "utf8");
  assert.ok(!/from "node:fs"|writeFile|appendFile|createWriteStream/.test(src), "memory only: the module does not touch a file");
});

test("the store keeps within its bytes per owner, oldest first out, and never touches another owner's", () => {
  const s = createStore({ maxBytes: 30_000 });
  const a = /** @type {any} */ (s.shape("a", big(120))).ref.handle;
  const b = /** @type {any} */ (s.shape("b", big(120))).ref.handle;
  const a2 = /** @type {any} */ (s.shape("a", big(120))).ref.handle;
  const a3 = /** @type {any} */ (s.shape("a", big(120))).ref.handle;
  assert.equal(/** @type {any} */ (s.read("a", { handle: a })).error.code, "not_found", "a's oldest went out");
  assert.ok(/** @type {any} */ (s.read("b", { handle: b })).data, "b's stays");
  assert.ok(s.bytesFor("a") <= 30_000);
  assert.ok(/** @type {any} */ (s.read("a", { handle: a3 })).data && a2);
});

test("results_read: a path, a page of a list, a page of a text; a slice is never again a large result", () => {
  const s = createStore();
  const h = /** @type {any} */ (s.shape("o", big(214))).ref.handle;
  const page = /** @type {any} */ (s.read("o", { handle: h, select: "rows", offset: 10, limit: 3 })).data;
  assert.deepEqual([page.items.length, page.total, page.offset, page.next_offset], [3, 214, 10, 13]);
  assert.equal(page.items[0].id, "c_10");
  assert.equal(/** @type {any} */ (s.read("o", { handle: h, select: "next_cursor" })).data.value, "abc");
  const all = /** @type {any} */ (s.read("o", { handle: h, select: "rows", limit: 200 })).data;
  assert.ok(costOf(all.items) <= LIMITS.sliceTokens, "cut to fit");
  assert.equal(all.cut_to_fit, true);
  assert.ok(all.next_offset > 0);
  // the whole object is too large to hand back: it says so and offers the summary
  const whole = /** @type {any} */ (s.read("o", { handle: h })).data;
  assert.equal(whole.too_large, true);
  // a text pages by characters
  const t = /** @type {any} */ (s.shape("o", "word ".repeat(5000))).ref.handle;
  const first = /** @type {any} */ (s.read("o", { handle: t, limit: 100 })).data;
  assert.equal(first.text.length, 100);
  assert.equal(first.next_offset, 100);
  // a list result reads with `value`
  const l = /** @type {any} */ (s.shape("o", big(214).rows)).ref.handle;
  assert.equal(/** @type {any} */ (s.read("o", { handle: l, select: "value[2].id" })).data.value, "c_2");
});

test("select is a path and nothing that computes", () => {
  const s = createStore();
  const h = /** @type {any} */ (s.shape("o", big(214))).ref.handle;
  for (const select of ["len(rows)", "rows[0].id + 1", "rows[1 + 1]", "eval(1)", "rows[", "constructor"]) {
    const r = /** @type {any} */ (s.read("o", { handle: h, select }));
    assert.ok(r.error ? r.error.code === "bad_input" : r.data.value === null, `${select}: ${JSON.stringify(r).slice(0, 120)}`);
  }
});

test("what is stored is what the call returned: a sealed field stays a placeholder", () => {
  const s = createStore({ threshold: 10 });
  const v = { rows: Array.from({ length: 30 }, (_, i) => ({ id: i, ssn: "{{field:ssn}}" })) };
  const h = /** @type {any} */ (s.shape("o", v)).ref.handle;
  const back = /** @type {any} */ (s.read("o", { handle: h, select: "rows", limit: 2 })).data.items;
  assert.deepEqual(back, [{ id: 0, ssn: "{{field:ssn}}" }, { id: 1, ssn: "{{field:ssn}}" }]);
});

// ---------------------------------------------------------------- the MCP server, against a stand-in for vyred

/** A stand-in vyred on a socket: it lists some tools, answers each by a function, and records every request with its headers. */
async function fakeDaemon(/** @type {any} */ t, /** @type {Record<string, (input: any) => any>} */ tools) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "tr-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = path.join(dir, "t.sock");
  /** @type {{ method: string, url: string, caller: string, call: string | null, body: any }[]} */ const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* none */ }
      seen.push({ method: String(req.method), url: String(req.url), caller: String(req.headers["x-vyre-caller"] || ""), call: /** @type {string | null} */ (req.headers["x-vyre-call-id"] || null), body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET") return res.end(JSON.stringify({ data: Object.keys(tools).map((name) => ({ name, description: `the ${name} tool`, input: { type: "object" } })) }));
      const name = decodeURIComponent(String(req.url).slice("/v1/tools/".length));
      res.end(JSON.stringify(tools[name] ? tools[name](body) : { error: { code: "no_such_tool", message: name } }));
    });
  });
  await new Promise((r) => server.listen(sock, () => r(undefined)));
  t.after(() => new Promise((r) => server.close(() => r(undefined))));
  return { sock, seen };
}

/** An MCP server process aimed at a socket. */
function mcp(/** @type {any} */ t, /** @type {string} */ sock, extra = {}) {
  const env = { ...process.env, VYRE_HOME: tempHome(t), VYRE_SOCKET: sock, VYRE_THREAD: "t1", VYRE_MCP_FEATURES: "", ...extra };
  delete env.VYRE_AGENT; delete env.VYRE_HUB_CHILD;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: /** @type {any} */ (child.stdout) });
  /** @type {Map<number, any>} */ const got = new Map();
  lines.on("line", (l) => { try { const m = JSON.parse(l); got.set(m.id, m); } catch { /* not json */ } });
  let n = 100;
  const ask = async (/** @type {string} */ method, params = {}) => {
    const id = ++n;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 300 && !got.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    return got.get(id);
  };
  const callTool = async (/** @type {string} */ name, /** @type {any} */ args, meta = undefined) => { const r = (await ask("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) })).result; return { r, body: r.structuredContent ?? (() => { try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; } })() }; };
  return { ask, callTool, child, ready: ask("initialize", {}) };
}

const DESK = {
  "client.find": () => ({ data: { rows: [{ id: "c_1", name: "Dana Whitfield" }] } }),
  "matter.find": (/** @type {any} */ i) => ({ data: { rows: i && i.client === "c_1" ? [{ title: "Estate", stage: "Open" }, { title: "Old", stage: "Closed" }] : [] } }),
  "mail.send": () => ({ data: { id: "g_5", state: "held", message: "Held at the Gate" } }),
  "person.thing": () => ({ error: { code: "presence_required", message: "needs the person" } }),
  "big.list": () => ({ data: big(214) }),
  "docs.read": () => ({ data: "page ".repeat(6000) }),
};

test("tools_run over the MCP server: each step is its own call to the tool door, as the same caller with the same call id, and no batch door exists", async (t) => {
  const d = await fakeDaemon(t, DESK);
  const m = mcp(t, d.sock);
  await m.ready;
  const { body } = await m.callTool("tools_run", { steps: [
    { id: "c", call: "client.find", input: { q: "Whitfield" } },
    { id: "m", call: "matter.find", input: { client: { expr: "steps.c.rows[0].id" } } },
  ], return: { client: { expr: "steps.c.rows[0].name" }, open: { expr: "len(steps.m.rows)" } } }, { "claudecode/toolUseId": "toolu_run1" });
  assert.deepEqual([body.status, body.ran, body.result], ["done", ["c", "m"], { client: "Dana Whitfield", open: 2 }]);
  const posts = d.seen.filter((s) => s.method === "POST" && s.url.startsWith("/v1/tools/client.") || s.url.startsWith("/v1/tools/matter."));
  assert.deepEqual(posts.map((p) => p.url), ["/v1/tools/client.find", "/v1/tools/matter.find"]);
  assert.equal(new Set(posts.map((p) => p.caller)).size, 1, "one caller for every step");
  assert.deepEqual(posts.map((p) => p.call), ["toolu_run1", "toolu_run1"]);
  assert.deepEqual(posts[1].body, { client: "c_1" });
  assert.ok(!d.seen.some((s) => /batch/.test(s.url)), "there is no batch door: the tool door judges every step");
  // the same step through tools_call alone arrives the same way
  await m.callTool("tools_call", { tool: "matter.find", arguments: { client: "c_1" } }, { "claudecode/toolUseId": "toolu_alone" });
  const alone = d.seen.filter((s) => s.url === "/v1/tools/matter.find").pop();
  assert.equal(alone?.caller, posts[0].caller);
});

test("tools_run over the MCP server: a held step stops the script, a refused one stops it, and a checked-bad script runs nothing", async (t) => {
  const d = await fakeDaemon(t, DESK);
  const m = mcp(t, d.sock);
  await m.ready;
  const held = (await m.callTool("tools_run", { steps: [{ id: "a", call: "client.find" }, { id: "send", call: "mail.send", input: { to: "a@b.c" } }, { id: "after", call: "matter.find" }] })).body;
  assert.equal(held.status, "held");
  assert.deepEqual(held.ran, ["a", "send"]);
  assert.equal(held.stopped.held, "g_5");
  assert.ok(!d.seen.some((s) => s.url === "/v1/tools/matter.find"), "nothing ran past the hold");
  const refused = (await m.callTool("tools_run", { steps: [{ id: "p", call: "person.thing" }, { id: "after", call: "matter.find" }] })).body;
  assert.equal(refused.status, "refused");
  assert.equal(refused.stopped.code, "presence_required");
  const before = d.seen.length;
  const bad = await m.callTool("tools_run", { steps: [{ id: "a", call: "client.find" }, { id: "b", call: "tools_run" }, { id: "c", call: "no.such.tool" }] });
  assert.equal(bad.r.isError, true);
  assert.match(bad.r.content[0].text, /cannot run inside tools_run/);
  assert.equal(d.seen.length, before, "a script with a problem makes no call at all");
});

test("a large result comes back as a handle and a summary; results_read gets the slice; the handle is this process's own and gone after a restart", async (t) => {
  const d = await fakeDaemon(t, DESK);
  const m = mcp(t, d.sock);
  await m.ready;
  const { body } = await m.callTool("tools_call", { tool: "big.list", arguments: {} });
  assert.match(body.handle, /^r_/);
  assert.ok(body.tokens > 2000);
  assert.equal(body.summary.keys.rows, "array(214) of object");
  const slice = (await m.callTool("results_read", { handle: body.handle, select: "rows", offset: 5, limit: 2 })).body;
  assert.deepEqual(slice.items.map((/** @type {any} */ x) => x.id), ["c_5", "c_6"]);
  assert.equal(slice.total, 214);
  // another process (another session) cannot read it
  const other = mcp(t, d.sock);
  await other.ready;
  const stranger = await other.callTool("results_read", { handle: body.handle });
  assert.equal(stranger.r.isError, true);
  assert.match(stranger.r.content[0].text, /^not_found/);
  // dropped early, it is gone
  assert.equal((await m.callTool("tools_call", { tool: "results_drop", arguments: { handle: body.handle } })).body.dropped, true);
  assert.equal((await m.callTool("results_read", { handle: body.handle })).r.isError, true);
  // a restart drops every handle
  const again = (await m.callTool("tools_call", { tool: "big.list", arguments: {} })).body.handle;
  m.child.kill();
  const m2 = mcp(t, d.sock);
  await m2.ready;
  assert.equal((await m2.callTool("results_read", { handle: again })).r.isError, true);
  // a read whose whole text is the answer is not turned into a handle
  const doc = await m2.callTool("tools_call", { tool: "docs.read", arguments: {} });
  assert.equal(typeof doc.body, "string");
});

test("tools_run keeps a large step result at home: only the return leaves, and a large return comes back as a handle", async (t) => {
  const d = await fakeDaemon(t, DESK);
  const m = mcp(t, d.sock);
  await m.ready;
  const small = (await m.callTool("tools_run", { steps: [{ id: "b", call: "big.list" }], return: { first: { expr: "steps.b.rows[0].name" }, n: { expr: "len(steps.b.rows)" } } })).body;
  assert.deepEqual(small.result, { first: "Client number 0", n: 214 });
  assert.ok(tokens(JSON.stringify(small)) < 100, "the 214 rows never reached the model");
  const whole = (await m.callTool("tools_run", { steps: [{ id: "b", call: "big.list" }], return: { all: { expr: "steps.b" } } })).body;
  assert.match(whole.result.handle, /^r_/);
  const noReturn = (await m.callTool("tools_run", { steps: [{ id: "b", call: "big.list" }] })).body;
  assert.match(noReturn.steps.b.handle, /^r_/, "without a return, a large step result is a handle");
});

test("an fn step runs in the Flows Code sandbox where the machine can prove one", async (t) => {
  const d = await fakeDaemon(t, DESK);
  const m = mcp(t, d.sock);
  await m.ready;
  const { body } = await m.callTool("tools_run", { steps: [
    { id: "m", call: "matter.find", input: { client: "c_1" } },
    { id: "s", fn: "return { open: inputs.m.rows.filter(r => r.stage != 'Closed').map(r => r.title) };", inputs: { m: { expr: "steps.m" } } },
  ], return: { open: { expr: "steps.s.open" } } });
  if (body.status === "error" && body.stopped && body.stopped.code === "unavailable") { t.skip(`no code sandbox here: ${body.stopped.message}`); return; }
  assert.equal(body.status, "done", JSON.stringify(body));
  assert.deepEqual(body.result, { open: ["Estate"] });
  // the code cannot reach a tool: it has no network, no files and no way to call out
  const probe = (await m.callTool("tools_run", { steps: [{ id: "s", fn: "const r = await fetch('http://127.0.0.1:1/'); return { r: String(r) };" }] })).body;
  assert.notEqual(probe.status, "done");
});

test("the listing stays small: tools_run and results_read join the core within 30 tools and 6,000 tokens", () => {
  assert.deepEqual(META_TOOLS.map((x) => x.name), ["tools_find", "tools_run", "results_read", "tools_call"]);
  const l = listing(catalogOf([]));
  assert.ok(l.length <= 30);
  assert.ok(tokens(JSON.stringify(META_TOOLS)) < 900, `the four meta tools cost ${tokens(JSON.stringify(META_TOOLS))} tokens`);
});

test("against a real vyred: a chain reads one real result into the next, and a step the door rejects is rejected the same way it is alone", async (t) => {
  const { start } = await import("../core/daemon/index.js");
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { ...process.env, VYRE_HOME: root };
  delete env.VYRE_SOCKET; delete env.VYRE_AGENT; delete env.VYRE_HUB_CHILD;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const got = new Map();
  readline.createInterface({ input: /** @type {any} */ (child.stdout) }).on("line", (l) => { try { const m = JSON.parse(l); got.set(m.id, m); } catch { /* not json */ } });
  const ask = async (/** @type {number} */ id, /** @type {string} */ method, params = {}) => { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); for (let i = 0; i < 300 && !got.has(id); i++) await new Promise((r) => setTimeout(r, 50)); return got.get(id); };
  await ask(1, "initialize", {});
  const run = async (/** @type {number} */ id, /** @type {any} */ args) => (await ask(id, "tools/call", { name: "tools_run", arguments: args })).result;
  const chain = await run(2, { steps: [{ id: "a", call: "system.echo", input: { text: "hello" } }, { id: "b", call: "system_echo", input: { text: { expr: "steps.a.text + ' world'" } } }], return: { said: { expr: "steps.b.text" } } });
  const body = JSON.parse(chain.content[0].text);
  assert.deepEqual([body.status, body.ran, body.result], ["done", ["a", "b"], { said: "hello world" }]);
  // the same bad call alone and inside a script is turned away with the same code
  const alone = (await ask(3, "tools/call", { name: "tools_call", arguments: { tool: "system.echo", arguments: { text: 7 } } })).result;
  const inBatch = JSON.parse((await run(4, { steps: [{ id: "a", call: "system.echo", input: { text: 7 } }] })).content[0].text);
  assert.equal(alone.isError, true);
  assert.equal(inBatch.status === "done", false);
  assert.equal(`${alone.content[0].text}`.startsWith(`${inBatch.stopped.code}:`), true, `alone: ${alone.content[0].text}; in a batch: ${JSON.stringify(inBatch.stopped)}`);
  // the listing carries the two new tools and stays within the budget
  const listed = (await ask(5, "tools/list")).result.tools;
  assert.ok(["tools_run", "results_read"].every((n) => listed.some((/** @type {any} */ x) => x.name === n)) && listed.length <= 30);
});

test("results by reference: a list is narrowed by where, sort and fields before it is paged, and the summary names the list to read", async () => {
  const { createStore } = await import("../lib/results-store.js");
  const store = createStore({ threshold: 10 });
  const rows = ["delta", "alpha", "charlie", "bravo"].map((n, i) => ({ id: `r${i}`, data: { name: n, stage: i % 2 ? "Open" : "Closed" }, noise: "x".repeat(50) }));
  const s = store.shape("o", { result: { ok: true, records: rows }, component: { kind: "list" } });
  assert.ok("ref" in s);
  assert.equal(s.ref.summary.head.in, "result.records");
  assert.equal(s.ref.summary.head.count, 4);
  assert.ok(s.ref.summary.head.fields.includes("data.name"));
  const first = store.read("o", { handle: s.ref.handle, select: "result.records", sort: "data.name", fields: ["data.name"], limit: 2 });
  assert.deepEqual(first.data.items, [{ "data.name": "alpha" }, { "data.name": "bravo" }]);
  assert.equal(first.data.total, 4);
  const open = store.read("o", { handle: s.ref.handle, select: "result.records", where: { "data.stage": "Open" }, sort: "-data.name", fields: ["id", "data.name"] });
  assert.deepEqual(open.data.items.map((/** @type {any} */ x) => x["data.name"]), ["bravo", "alpha"]);
});

test("results by reference is off in a real session and on only when VYRE_MCP_FEATURES asks for it", async () => {
  const { featuresOf, listing, catalogOf } = await import("../harness/mcp/core-tools.js");
  assert.deepEqual(featuresOf(undefined), { run: true, ref: false }, "unset: tools_run, no references");
  assert.deepEqual(featuresOf(""), { run: true, ref: true });
  assert.deepEqual(featuresOf("ref"), { run: false, ref: true });
  assert.deepEqual(featuresOf("none"), { run: false, ref: false });
  void listing; void catalogOf;
});
