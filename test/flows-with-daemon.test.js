// @ts-check
// A later send rides an earlier step's yes (`with`, kernel/flows/rides.js), on a real daemon with the real approvals queue and Gate: a signing Flow asks ONE question, the person says yes once, the
// request goes out, the run waits for the signature, and the signed copy goes out after with no second question and nothing held at the Gate. A rider that the question did not list is refused.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, writeModule } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const canonical = (/** @type {any} */ x) => JSON.stringify(x, Object.keys(x).sort());
const signedPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 40_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(what); await new Promise(r => setTimeout(r, 100)); } };

const TOOLS = ["esign.request", "esign.copy", "esign.other"];
const SOURCE = `export default { async start(ctx) { for (const n of ${JSON.stringify(TOOLS)}) ctx.tool(n, { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { const r = await ctx.call("gate.request", { kind: "send", via: "mail", to: i.to, content: { subject: n, body: "b" }, why: "signing" }); if (r && r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data || r; } }); return {}; } };`;

async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  const mods = path.join(root, "modules");
  const sent = /** @type {string[]} */ ([]);
  const outbox = http.createServer((req, res) => { let b = ""; req.on("data", d => (b += d)); req.on("end", () => { sent.push(b); res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","threadId":"t1"}'); }); });
  await new Promise(r => outbox.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => outbox.close(() => r(undefined))));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false }, projectsDir: path.join(root, "projects"), vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "mail-token", from: "alex@example.com", base: `http://127.0.0.1:${/** @type {any} */ (outbox.address()).port}` } } } }));
  const flowStep = (/** @type {string} */ name) => ({ name, label: name, outward: true, inputs: { to: "string" }, outputs: {} });
  writeModule(mods, "esign", { version: "0.1.0", flow: { steps: TOOLS.map(n => flowStep(n)) },
    does: { tools: [{ name: "esign.request", reach: "anyone", outward: true, covers: ["esign.copy"], effect: "write", summary: "send for signature" }, { name: "esign.copy", reach: "anyone", outward: true, effect: "write", summary: "email the signed copy" }, { name: "esign.other", reach: "anyone", outward: true, effect: "write", summary: "email something else" }] }, needs: { tools: ["gate.request"] } }, SOURCE);
  const boot = () => start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: signedPresence(), firstPartyRoots: [mods] });
  let d = await boot();
  t.after(() => d.stop().catch(() => {}));
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  const asPerson = async (/** @type {string} */ name, /** @type {any} */ input) => { const r = await d.registry.call(name, input, "cli", await meta()); if (r.error) throw Object.assign(new Error(`${name}: ${r.error.message || r.error.code}`), { code: r.error.code }); return r.data; };
  await asPerson("vault.put", { name: "mail-token", kind: "api-key", fields: { value: "fixture-token-1" } });
  await asPerson("vault.grant", { name: "mail-token", module: "gate" });
  const gateHeld = async () => { const h = await asPerson("gate.held", {}); return (h.items ?? h).length; };
  const w = { d, admin, meta, asPerson, host: d.registry.deps.flowsHost.get(space), sent, gateHeld,
    /** the server stops and starts again on the same home */
    restart: async () => { await d.stop(); d = await boot(); w.d = d; w.host = d.registry.deps.flowsHost.get(space); } };
  return w;
}

const stepsOf = (/** @type {any} */ rider, wait = 1500) => [
  { id: "request", kind: "call", action: "esign.request", resource: "vyre://space/esign", input: { to: "dana@example.com" }, approve: true },
  { id: "w", kind: "wait", for_ms: wait },
  { id: "copy", kind: "call", action: rider.action || "esign.copy", resource: "vyre://space/esign", label: "email Dana the signed copy", input: { to: "dana@example.com" }, with: "request", ...rider },
];

test("a signing Flow costs one yes and sends two emails: the signed copy rides the request's yes after the wait, and nothing is held at the Gate", { timeout: 240_000 }, async t => {
  const w = await world(t);
  const flow = { format: 1, name: "signing", label: "Signing", authorship: "human", trigger: { on: "manual" }, steps: stepsOf({}) };
  const def = await w.asPerson("flows.define", { flow });
  assert.ok(def.ok, JSON.stringify(def));
  await w.host.flows.tools["flows.approve"](w.host.personChain(), { id: def.id, version: def.version, hash: def.hash });
  const started = await w.asPerson("flows.start", { id: def.id });
  const runId = started.run || started.id;
  const state = async () => (await w.asPerson("flows.run", { run: runId })).run;
  await until(async () => (await state()).state === "waiting", "the run to wait on its question");
  const task = await until(async () => (await w.d.kernel.gateway.ask.list(w.admin, { state: ["needs_check"] })).find((/** @type {any} */ x) => x.form && x.form.kind === "held_act"), "the Flow's question");
  assert.match(task.title, /esign.request|send for signature/i);
  assert.match(task.title, /email Dana the signed copy/, "the one question names both sends");
  const row = await w.d.kernel.gateway.ask.get(w.admin, task.id);
  await w.d.kernel.gateway.ask.decide(w.admin, task.id, { outcome: "approved", proof: { op: "task.decide", fields: { task: task.id, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: `n${Math.random()}` } });
  await until(() => w.sent.length === 1, "the request reached the mail server", 90_000);
  let last = /** @type {any} */ (null);
  const done = await until(async () => { const r = last = await state(); return r.state === "done" ? r : r.state === "failed" ? assert.fail(JSON.stringify(r.error)) : null; }, "the run to finish after the wait", 60_000).catch(e => { e.message += ` (last: ${JSON.stringify(last && { state: last.state, waiting: last.waiting, steps: last.steps, error: last.error }).slice(0, 900)}; sent ${w.sent.length})`; throw e; });
  assert.equal(done.state, "done");
  assert.equal(w.sent.length, 2, "exactly two emails went out");
  assert.equal(await w.gateHeld(), 0, "nothing waits at the Gate for a second yes");
  const questions = (await w.d.kernel.gateway.ask.list(w.admin, {})).filter((/** @type {any} */ x) => x.form && x.form.kind === "held_act");
  assert.equal(questions.length, 1, "the person was asked once");
});

test("a rider the question did not list is refused, and a Flow naming a tool the earlier send does not cover does not save", { timeout: 240_000 }, async t => {
  const w = await world(t);
  const bad = await w.d.registry.call("flows.define", { flow: { format: 1, name: "signing_bad", label: "Signing", authorship: "human", trigger: { on: "manual" }, steps: stepsOf({ action: "esign.other" }) } }, "cli", await w.meta());
  assert.ok(bad.error || (bad.data && bad.data.ok === false), "esign.request does not name esign.other, so the Flow does not save");
  assert.match(JSON.stringify(bad), /does not name esign.other among the sends it covers/);
});

test("the server stops and starts again while the run waits for the signature: the copy still rides the yes, with no second question", { timeout: 300_000 }, async t => {
  const w = await world(t);
  const def = await w.asPerson("flows.define", { flow: { format: 1, name: "signing_restart", label: "Signing", authorship: "human", trigger: { on: "manual" }, steps: stepsOf({}, 8000) } });
  assert.ok(def.ok, JSON.stringify(def));
  await w.host.flows.tools["flows.approve"](w.host.personChain(), { id: def.id, version: def.version, hash: def.hash });
  const started = await w.asPerson("flows.start", { id: def.id });
  const runId = started.run || started.id;
  // the run must be waiting on its question before the person answers it (an answer in the instant between the question and the wait is a race a person never wins)
  await until(async () => (await w.asPerson("flows.run", { run: runId })).run.state === "waiting", "the run to wait on its question");
  const task = await until(async () => (await w.d.kernel.gateway.ask.list(w.admin, { state: ["needs_check"] })).find((/** @type {any} */ x) => x.form && x.form.kind === "held_act"), "the Flow's question");
  const row = await w.d.kernel.gateway.ask.get(w.admin, task.id);
  await w.d.kernel.gateway.ask.decide(w.admin, task.id, { outcome: "approved", proof: { op: "task.decide", fields: { task: task.id, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: `n${Math.random()}` } });
  await until(() => w.sent.length === 1, "the request reached the mail server");
  await until(async () => { const r = (await w.asPerson("flows.run", { run: runId })).run; return r.state === "waiting" && r.waiting && r.waiting.kind === "time"; }, "the run to wait for the signature");

  await w.restart();
  const done = await until(async () => { const r = (await w.asPerson("flows.run", { run: runId })).run; return r.state === "done" ? r : r.state === "failed" || r.state === "paused" ? assert.fail(`the run ${r.state}: ${JSON.stringify(r.error)}`) : null; }, "the run to finish after the restart", 90_000);
  assert.equal(done.state, "done");
  assert.equal(w.sent.length, 2, "both emails, once each");
  assert.equal(await w.gateHeld(), 0, "nothing held at the Gate");
  const questions = (await w.d.kernel.gateway.ask.list(w.admin, {})).filter((/** @type {any} */ x) => x.form && x.form.kind === "held_act");
  assert.equal(questions.length, 1, "the person was asked once");
});
