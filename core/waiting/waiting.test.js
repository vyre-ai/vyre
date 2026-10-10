// @ts-check
// The waiting module and the real approvals queue against fake threads, gate, vault, planner and link modules in a temp home. The fakes
// answer with the owners' real shapes (core/switchboard/asks.js shape, core/gate/gate.js brief, core/vault vault.pending,
// core/planner/index.js planner.ringing, core/link/box.js link.pending). Asks, drafts and vault requests reach waiting as cards of the approvals queue.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { clean, tally, fromPending } from "./index.js";
import { fromAsks } from "../approvals/items.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../../kernel/bus.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const wait = ms => new Promise(r => setTimeout(r, ms));
const T = 1_790_000_000_000;

const ASK_Q = { id: "a1", thread: "t-harlow", tool: "AskUserQuestion", summary: "Which palette should the Northwind Bakery menu use?", destination: null, reason: null,
  at: T + 1000, state: "open", decision: null, kind: "question", questions: [{ question: "Which palette should the Northwind Bakery menu use?", options: [] }],
  agent: "kit", thread_name: "Menu redesign", anchor: { tool_use_id: "tu1", event: 4 }, always: false, always_project: null, presence: { required: false, covered: false, since: null } };
const ASK_P = { id: "a2", thread: "t-harlow", tool: "Bash", summary: "Bash npm test", destination: null, reason: null, at: T + 4000, state: "open", decision: null,
  kind: "permission", agent: null, thread_name: null, anchor: { tool_use_id: null, event: null }, always: true, always_project: null, presence: { required: false, covered: false, since: null } };
const HELD = { id: "g1", kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Re: the Harlow Legal retainer", why: "the client asked for it",
  agent: "juno", thread: "t-harlow", project: "harlow-legal", at: T + 3000, anchor: { tool_use_id: null, event: 9, thread: "t-harlow", at: T + 3000 },
  presence: { required: true, covered: false, since: null } };
const RING = { firing: "f1", key: `planner-i1-${Math.floor((T + 2000) / 1000)}`, item: "i1", kind: "reminder", title: "Call alex about the bakery lease", due: T + 2000, ring: 1, missed: false, actions: ["done", "snooze"] };
const PAIR = { id: "p1", name: "alex's MacBook", login: "alex@example.com", node: "alex-mbp", expires: T + 600_000 };

const fake = (name, tool, key, extra = "") => [name, [tool],
  `export default { async start(ctx) { ctx.tool(${JSON.stringify(tool)}, { effect: "read", ${extra} run: async () => { globalThis.calls[${JSON.stringify(tool)}] = (globalThis.calls[${JSON.stringify(tool)}] || 0) + 1;
    const v = globalThis.fake[${JSON.stringify(key)}]; if (v instanceof Error) throw v; return v; } }); return {}; } };`];
const GRANT = { id: "g_1", name: "billing-key", module: "mail", status: "pending", by: "mcp", at: T + 5000 };
const VAULT = { grants: [GRANT], passes: [], agentGrants: [], people: [], accepts: [] };
const ALL = [fake("threads", "threads.asks", "asks"), fake("gate", "gate.held", "held"), fake("vault", "vault.pending", "vault"), fake("flows", "flows.attention", "attn"), fake("models", "models.evals", "evals"), fake("planner", "planner.ringing", "ringing"), fake("link", "link.pending", "pending")];

async function world(t, fakes = ALL, data = {}, role = "box") {
  /** @type {any} */ (globalThis).fake = { asks: [], held: [], vault: { grants: [], passes: [], agentGrants: [], people: [], accepts: [] }, attn: { runs: [] }, evals: { evals: [] }, ringing: [], pending: [], ...data };
  /** @type {any} */ (globalThis).calls = {};
  const home = tempHome(t);
  const root = path.join(home, "mods");
  for (const [name, tools, src] of fakes) writeModule(root, name, { roles: ["box", "local"], does: { tools }, watches: { emits: [] } }, src);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const said = [];
  events.on("waiting.changed", e => said.push(e.payload));
  const reg = new Registry({ db, events, config: { role }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => ["waiting", "approvals"].includes(f.manifest?.name));
  await reg.start([...core, ...discover([root])], { role });
  t.after(async () => { await reg.stop?.(); db.close(); });
  const call = async (tool, input = {}, caller = "cli") => (await reg.call(tool, input, caller));
  return { reg, events, said, call, calls: /** @type {any} */ (globalThis).calls, data: /** @type {any} */ (globalThis).fake };
}

test("waiting.list: the four sources in one list, newest first, with source-prefixed ids and a tally", async t => {
  const w = await world(t, ALL, { asks: [ASK_Q, ASK_P], held: [HELD], ringing: [RING], pending: [PAIR] });
  const r = (await w.call("waiting.list")).data;
  assert.deepEqual(r.rows.map(x => x.id), ["threads:a2", "gate:g1", "planner:f1", "threads:a1", "link:p1"]);
  assert.deepEqual(r.rows.map(x => x.kind), ["ask", "draft", "reminder", "ask", "pairing"]);
  assert.equal(r.count, 5);
  assert.deepEqual(r.by_kind, { approval: 0, ask: 2, draft: 1, access: 0, run: 0, task: 0, eval: 0, reminder: 1, pairing: 1 });
  assert.equal(r.partial, undefined);
  assert.deepEqual(r.rows.find(x => x.id === "gate:g1"), { id: "gate:g1", kind: "draft", title: "Re: the Harlow Legal retainer", detail: "mail to dana@harlowlegal.com",
    project: "harlow-legal", thread: "t-harlow", at: T + 3000, source: "gate", answer: { tool: "gate.approve", input: { id: "g1" }, fill: [] }, presence: { required: true, covered: false, since: null } });
  assert.ok(!JSON.stringify(r).includes("the client asked"), "nothing from the draft beyond the summary");
  assert.deepEqual((await w.call("waiting.count")).data, { count: 5, by_kind: { approval: 0, ask: 2, draft: 1, access: 0, run: 0, task: 0, eval: 0, reminder: 1, pairing: 1 } });
  for (const who of ["deck", "capsule", "local", "module:push"]) assert.ok((await w.call("waiting.list", {}, who)).data, who);
  assert.equal((await w.call("waiting.list", {}, "mcp")).error.code, "denied", "a model does not read the queue");
});

test("waiting.list: each kind says which owner tool answers it and what the person still gives", async t => {
  const w = await world(t, ALL, { asks: [ASK_Q, ASK_P], held: [HELD], ringing: [RING], pending: [PAIR] });
  const by = Object.fromEntries((await w.call("waiting.list")).data.rows.map(x => [x.id, x]));
  assert.deepEqual(by["threads:a1"].answer, { tool: "threads.answer", input: { ask: "a1" }, fill: ["decision", "answers"] });
  assert.deepEqual(by["threads:a2"].answer, { tool: "threads.answer", input: { ask: "a2" }, fill: ["decision"] });
  assert.deepEqual(by["planner:f1"].answer, { tool: "planner.done", input: { firing: "f1" }, fill: [] });
  assert.deepEqual(by["link:p1"].answer, { tool: "link.pair.approve", input: {}, fill: ["code"] });
  assert.equal(by["threads:a1"].title, "Which palette should the Northwind Bakery menu use?");
  assert.equal(by["threads:a1"].detail, "kit in Menu redesign");
  assert.equal(by["threads:a1"].thread, "t-harlow");
  assert.equal(by["planner:f1"].title, "Call alex about the bakery lease");
  assert.equal(by["planner:f1"].at, T + 2000, "a ring is dated by when it was due");
  assert.equal(by["link:p1"].title, `Pair the Mac "alex's MacBook"`);
  assert.equal(by["link:p1"].at, T, "no created field yet: falls back to its expiry less the box's ten minutes");
  assert.ok(!JSON.stringify(by["link:p1"]).includes("code\":\""), "never a code");
});

test("fromPending: a box's real created time wins over the expiry-minus-TTL guess", () => {
  // core/link/box.js now sends `created`, so the exact request time shows even when it does not
  // land exactly ten minutes before `expires` (a clock skew, a future TTL change on the box).
  const withCreated = fromPending([{ id: "p2", name: "alex's iMac", login: "alex@example.com", node: "alex-imac", created: T + 500, expires: T + 900_000 }]);
  assert.equal(withCreated[0].at, T + 500);
  // An older box that has not shipped `created` yet still falls back to the ten-minute guess.
  const withoutCreated = fromPending([{ id: "p3", name: "alex's iPad", login: "alex@example.com", node: "alex-ipad", expires: T + 600_000 }]);
  assert.equal(withoutCreated[0].at, T);
});

test("waiting.list: a failing, refused or missing source leaves its name in partial and the rest still show", async t => {
  const w = await world(t, [fake("threads", "threads.asks", "asks"), fake("gate", "gate.held", "held"), fake("planner", "planner.ringing", "ringing", `callers: ["cli"],`)],
    { asks: [ASK_P], held: new Error("gate broke"), ringing: [RING] });
  const r = (await w.call("waiting.list")).data;
  assert.deepEqual(r.rows.map(x => x.id), ["threads:a2"]);
  assert.deepEqual([...r.partial].sort(), ["flows", "gate", "link", "models", "planner", "vault"], "threw, refused module callers, not running here");
  assert.deepEqual(r.by_kind, { approval: 0, ask: 1, draft: 0, access: 0, run: 0, task: 0, eval: 0, reminder: 0, pairing: 0 });
});

test("waiting.list: limit cuts the rows, never the count", async t => {
  const w = await world(t, ALL, { asks: [ASK_Q, ASK_P], held: [HELD], ringing: [RING], pending: [PAIR] });
  const r = (await w.call("waiting.list", { limit: 2 })).data;
  assert.deepEqual(r.rows.map(x => x.id), ["threads:a2", "gate:g1"]);
  assert.equal(r.count, 5);
});

test("titles: an owner's summary shaped like a credential is dropped whole, not shown", async t => {
  assert.equal(clean("Bash curl -H 'Authorization: Bearer " + "q".repeat(40) + "'"), "");
  assert.equal(clean("export API_KEY=" + "x".repeat(10)), "");
  assert.equal(clean("  Bash   npm test "), "Bash npm test");
  assert.equal(clean("a ".repeat(200)).length, 120);
  assert.deepEqual(tally([{ kind: "ask" }, { kind: "ask" }]), { count: 2, by_kind: { approval: 0, ask: 2, draft: 0, access: 0, run: 0, task: 0, eval: 0, reminder: 0, pairing: 0 } });
  const leaky = { ...ASK_P, summary: "Bash deploy --token " + "sk-" + "z".repeat(30) };
  const w = await world(t, ALL, { asks: [leaky] });
  const [row] = (await w.call("waiting.list")).data.rows;
  assert.equal(row.title, "Allow Bash?");
});

test("waiting.changed: after the owners' events, coalesced, and only when the count or the kinds move", async t => {
  const w = await world(t, ALL, { asks: [ASK_P] });
  await wait(900);                                              // the first computation at start
  assert.deepEqual(w.said, [{ count: 1, by_kind: { approval: 0, ask: 1, draft: 0, access: 0, run: 0, task: 0, eval: 0, reminder: 0, pairing: 0 } }]);

  // A burst of events is one change: a draft is held, and the approvals queue says so once.
  w.data.held = [HELD];
  for (let i = 0; i < 5; i++) w.events.emit("gate", "gate.held", { id: `g${i}` });
  w.events.emit("switchboard", "ask.raised", { ask: "a9" });
  await wait(1000);
  assert.deepEqual(w.said.at(-1), { count: 2, by_kind: { approval: 0, ask: 1, draft: 1, access: 0, run: 0, task: 0, eval: 0, reminder: 0, pairing: 0 } });
  assert.equal(w.said.length, 2);

  // waiting.count after the event reads the cache, with no call to any owner.
  const before = w.calls["gate.held"];
  assert.deepEqual((await w.call("waiting.count")).data, { count: 2, by_kind: { approval: 0, ask: 1, draft: 1, access: 0, run: 0, task: 0, eval: 0, reminder: 0, pairing: 0 } });
  assert.equal(w.calls["gate.held"], before);

  // An event that changes nothing says nothing.
  w.events.emit("gate", "gate.revised", { id: "g1" });
  await wait(1000);
  assert.equal(w.said.length, 2);

  // The vault's pending request is a card of the same queue.
  w.data.vault = VAULT;
  w.events.emit("vault", "grant.requested", { name: "billing-key", module: "mail" });
  await wait(1000);
  assert.deepEqual(w.said.at(-1), { count: 3, by_kind: { approval: 0, ask: 1, draft: 1, access: 1, run: 0, task: 0, eval: 0, reminder: 0, pairing: 0 } });
  w.data.vault = { grants: [], passes: [], agentGrants: [], people: [], accepts: [] };
  w.events.emit("vault", "vault.granted", { name: "billing-key", module: "mail" });
  await wait(1000);
  assert.equal(w.said.at(-1).by_kind.access, 0);

  // The same count with the kinds swapped is a change.
  w.data.held = [];
  w.data.ringing = [RING];
  w.events.emit("gate", "gate.released", { id: "g1" });
  w.events.emit("planner", "planner.fired", { firing: "f1" });
  await wait(1000);
  assert.deepEqual(w.said.at(-1), { count: 2, by_kind: { approval: 0, ask: 1, draft: 0, access: 0, run: 0, task: 0, eval: 0, reminder: 1, pairing: 0 } });

  // Events that never change what waits do not recompute at all.
  const n = w.calls["planner.ringing"];
  w.events.emit("planner", "planner.added", { item: "i2" });
  w.events.emit("link", "link.connected", {});
  w.events.emit("switchboard", "thread.text", { text: "hi" });
  await wait(800);
  assert.equal(w.calls["planner.ringing"], n);

  // A pairing request and its approval.
  const count = w.said.length;
  w.data.pending = [PAIR];
  w.events.emit("link", "link.pair-requested", { id: "p1" });
  await wait(600);
  assert.equal(w.said.at(-1).by_kind.pairing, 1);
  w.data.pending = [];
  w.events.emit("link", "link.paired", { peer: "x" });
  await wait(600);
  assert.equal(w.said.at(-1).by_kind.pairing, 0);
  assert.equal(w.said.length, count + 2);
});

test("approvals.items: a held draft is a card, the owner's settling closes it, and the card keeps what became of it", async t => {
  const w = await world(t, ALL, { held: [HELD], asks: [ASK_P], vault: VAULT });
  const open = (await w.call("approvals.items")).data;
  assert.deepEqual(open.items.map(x => x.id).sort(), ["gate:g1", "threads:a2", "vault:g_1"]);
  assert.deepEqual(open.items.find(x => x.id === "vault:g_1"), { id: "vault:g_1", kind: "access", title: 'Let mail use "billing-key"', detail: "asked by mcp", at: T + 5000, source: "vault",
    state: "waiting", answer: { tool: "vault.approve", input: { id: "g_1" }, fill: [] }, presence: { required: true, covered: false, since: null } });
  assert.deepEqual(open.recent, []);
  w.data.held = [];
  w.events.emit("gate", "gate.rejected", { id: "g1", by: "cli" });
  await wait(500);
  const next = (await w.call("approvals.items")).data;
  assert.deepEqual(next.items.map(x => x.id).sort(), ["threads:a2", "vault:g_1"]);
  assert.equal(next.recent.length, 1);
  assert.equal(next.recent[0].id, "gate:g1");
  assert.equal(next.recent[0].outcome, "refused");
  assert.equal(next.recent[0].state, "settled");
  assert.ok(!JSON.stringify(open).includes("the client asked"), "nothing from the draft beyond its summary");
  assert.equal((await w.call("approvals.items", {}, "mcp")).error.code, "denied", "a model does not read the queue");
  // A model in a session, proven by its own socket (a thread, an agent, the assistant), is refused as well as the bare label: the queue holds drafts and where they go.
  for (const [caller, meta] of [["mcp:thread:t-harlow", { thread: "t-harlow" }], ["mcp:agent:kit", { thread: "t-harlow", agent: "kit", agentKind: "agent" }], ["mcp:agent:juno", { thread: "t-harlow", agent: "juno", agentKind: "assistant" }], ["harness", { thread: "t-harlow" }]]) {
    const r = await w.reg.call("approvals.items", {}, caller, meta);
    assert.equal(r.error?.code, "denied", `${caller} must not read the approval queue: ${JSON.stringify(r).slice(0, 120)}`);
  }
});

test("fromAsks: an ask from a session on the paired Mac names its machine and is answered there", async () => {
  const [mac, box] = fromAsks([
    { id: "a1", kind: "permission", tool: "Bash", summary: "npm test", source: "mac", machine: "alex-mbp", at: 2 },
    { id: "a2", kind: "permission", tool: "Bash", summary: "ls", at: 1 },
  ]);
  assert.equal(mac.machine, "alex-mbp");
  assert.deepEqual(mac.answer, { tool: null, input: null, fill: [], on: "alex-mbp" }, "answered on the Mac until federation lands");
  assert.equal(fromAsks([{ id: "a3", kind: "question", source: "mac", at: 3 }])[0].answer.on, "your Mac");
  assert.equal(box.machine, undefined);
  assert.deepEqual(box.answer.input, { ask: "a2" });
});

test("waiting.list on a Mac leaves out the planner, which is the box's over the link", async t => {
  const w = await world(t, ALL, { ringing: [RING], pending: [PAIR] }, "local");
  const r = (await w.call("waiting.list")).data;
  assert.ok(!r.rows.some(x => x.source === "planner"));
  assert.ok(r.rows.some(x => x.source === "link"));
  assert.equal(w.calls["planner.ringing"] || 0, 0, "a Mac's vyred never asks the box's planner on its own");
});
