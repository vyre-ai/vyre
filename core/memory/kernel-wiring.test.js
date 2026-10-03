// @ts-check
// The 0.3 minimum for core/memory (CUTOVER section G): on a REAL kernel (test/kernel-rig.js), personal memory is refused to a group chat, readable only by its person and that
// person's own assistant (decided by the kernel's chain, not the 0.2 caller label), and sealed values never enter it. Corrections, pins, taught facts, agent writes and site rows
// survive a schema change. Only the projects.reach stand-in (a 0.2 module this one asks) and the model are stand-ins.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import { createRig } from "../../test/kernel-rig.js";
import { MIGRATIONS } from "./schema.js";
import { scrubIn, scanRows } from "./sealed.js";
import memory from "./index.js";
import { CAPSULE_EXCEPTION } from "./kernel-gate.js";

const AGENTS = [{ name: "kit", kind: "assistant", projects: "*" }];
const SSN = "123-45-6789";
/** What the daemon proves for a person's own surface on the socket (core/daemon callerFacts): set by the daemon only. */
const surface = (label, uid = 501) => ({ kernelFacts: { kind: "socket", surface: label, uid, pid: 1, inside_model_process: false, capsule_verified: true } });

async function world(t) {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["kit"] });
  const handle = rig.k.kernelFor({ name: "memory", needs: { kernel: { membership: true } } });
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  const tools = new Map();
  const calls = [], prompts = [];
  // The work module is not started here: its tools are answered by stand-ins so the test sees what memory asks of it and what it never asks.
  const space = { hits: [], answer: null };
  const ctx = {
    name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => { calls.push(tool); return tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : tool === "work.know.search" ? { data: { hits: space.hits } } : tool === "work.know.answer" ? (space.answer || { data: { result: { text: "", citations: [] } } }) : fakeReachCall(tool, input, { agents: AGENTS, projects: [] }); },
    tool: (name, def) => tools.set(name, def), kernel: handle, memoryRunner: null,
    iqRunner: async ({ prompt }) => { prompts.push(prompt); return { text: JSON.stringify({ answer: null, cite: [], confidence: 0, abstain: true, known: [] }), usd: 0 }; },
  };
  const h = await memory.start(ctx);
  t.after(() => h.stop());
  /** A tool's answer or its refusal, with the running call's session token bound the way the registry does it. */
  const call = async (name, input, caller, token, meta = {}) => {
    rig.k.bindCalls(() => (token ? { token } : null));
    try { return { data: await tools.get(name).run(input, { caller, ...(token ? { token } : {}), ...meta }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; }
  };
  const session = async (person, o = {}) => (await rig.k.surfaces.open(rig.person(person), o)).token;
  return { rig, call, db, tools, session, calls, prompts, space };
}

test("a. a group chat is refused personal memory, a one to one chat is not, and a call with no session is not in a chat", async t => {
  const w = await world(t);
  const G = rig => rig.k.gateway.grants.chats;
  const group = await w.rig.k.gateway.grants.chats.create(w.rig.person("per_alex"), { people: ["per_bob"] });
  const solo = await w.rig.k.gateway.grants.chats.create(w.rig.person("per_alex"), {});
  const tg = await w.session("per_alex", { chat: group.id }), ts = await w.session("per_alex", { chat: solo.id });
  for (const tool of ["memory.stats", "memory.facts", "memory.answer", "memory.me", "memory.retrieve"]) {
    const r = await w.call(tool, { question: "who", about: "Harlow" }, "deck", tg);
    assert.equal(r.code, "denied", `${tool}: ${r.error}`);
    assert.match(r.error, /not shared in a group chat/);
  }
  assert.ok(!(await w.call("memory.stats", {}, "deck", ts, surface("deck"))).error, "alone with the owner it answers");
  assert.ok(!(await w.call("memory.stats", {}, "deck", undefined, surface("deck"))).error, "a person's own surface with no chat session is not in a chat");
  void G;
});

test("a. a session whose room cannot be built is refused, not answered", async t => {
  const w = await world(t);
  const group = await w.rig.k.gateway.grants.chats.create(w.rig.person("per_bob"), { people: ["per_alex"] });
  const tok = await w.session("per_bob", { chat: group.id });
  await w.rig.k.gateway.grants.chats.change(w.rig.person("per_alex"), group.id, { remove_people: ["per_bob"] });
  const r = await w.call("memory.stats", {}, "deck", tok);
  assert.equal(r.code, "denied");
});

test("c. personal memory is read only by its person and that person's own assistant, decided by the kernel's chain", async t => {
  const w = await world(t);
  // the owner, alone, and the owner's own assistant standing beside them
  assert.ok(!(await w.call("memory.stats", {}, "deck", await w.session("per_alex"), surface("deck"))).error);
  assert.ok(!(await w.call("memory.stats", {}, "mcp:agent:kit", await w.session("per_alex", { agent: "kit" }), { agent: "kit", granted: "*" })).error, "the owner's own assistant");
  // another member of the Space, or their assistant: refused whatever the caller label says
  for (const [who, agent] of [["per_bob", undefined], ["per_bob", "kit"]]) {
    const tok = await w.session(who, agent ? { agent } : {});
    for (const label of ["deck", "cli", "capsule", "mcp", "tailnet:bob@example.com"]) {
      const r = await w.call("memory.stats", {}, label, tok);
      assert.equal(r.code, "denied", `${who} ${agent || ""} as ${label}`);
      assert.match(r.error, /only by its person and that person's own assistant/);
    }
  }
});

test("c. a call with no kernel chain is refused: the caller label decides nothing, and only the two named exceptions get past", async t => {
  const w = await world(t);
  // no chain at all: a model on the socket, a client's claim, an unproven caller, whatever label it wears
  for (const label of ["deck", "cli", "local", "mcp", "tailnet:alex@example.com", "harness", "hook"]) {
    const r = await w.call("memory.stats", {}, label);
    assert.equal(r.code, "denied", label);
    assert.match(r.error, /no kernel chain/);
  }
  // facts that do not hold (a uid that is not the owner's) build no person chain either
  assert.equal((await w.call("memory.stats", {}, "cli", undefined, surface("cli", 0))).code, "denied");
  // a person's own surface, proven by the daemon, is the owner
  for (const label of ["cli", "local", "deck"]) assert.ok(!(await w.call("memory.stats", {}, label, undefined, surface(label))).error, label);
  // the named exceptions: a first-party module's own call (the registry's flag), and the Capsule until platform wires it
  assert.ok(!(await w.call("memory.stats", {}, "module:assistant", undefined, { firstParty: true })).error);
  assert.equal((await w.call("memory.stats", {}, "module:assistant")).code, "denied", "a module that is not flagged first-party is no exception");
  assert.ok(!(await w.call("memory.stats", {}, CAPSULE_EXCEPTION)).error, "the Capsule exception");
});

test("c. with no kernel on the daemon nothing changes: the 0.2 rules stand alone", async t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  const tools = new Map();
  const ctx = { name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {}, events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => tool === "recall.search" ? { data: [] } : fakeReachCall(tool, input, { agents: AGENTS, projects: [] }), tool: (n, d) => tools.set(n, d), memoryRunner: null };
  const h = await memory.start(ctx);
  t.after(() => h.stop());
  assert.ok(await tools.get("memory.stats").run({}, { caller: "deck" }));
});

test("b. a value shaped like a sealed class is scrubbed on the way in, from every door", async t => {
  const w = await world(t);
  assert.deepEqual(scrubIn(`my ssn is ${SSN}, ok`).classes, ["us-ssn"]);
  assert.doesNotMatch(scrubIn(`ssn 123 45 6789 or 123456789`).text, /6789/);
  assert.equal(scrubIn("nothing here").text, "nothing here");
  const tok = await w.session("per_alex");
  const wrote = await w.call("memory.write", { kind: "note", text: `Jane's social security number is ${SSN}`, project: "you" }, "deck", tok);
  assert.ok(!wrote.error, wrote.error);
  const rem = await w.call("memory.remember", { text: `Jane Doe's ssn is ${SSN}` }, "deck", tok);
  assert.ok(!rem.error, rem.error);
  const rows = JSON.stringify([w.db.prepare("SELECT text FROM memory_writes").all(), w.db.prepare("SELECT text FROM memory_me_told").all(), w.db.prepare("SELECT obj FROM memory_me_claims").all()]);
  assert.doesNotMatch(rows, /123-45-6789|123 45 6789|123456789/);
  assert.match(rows, /\[sealed: US SSN #1\]/);
});

test("b. the one-time scan reports what memory already holds, by table and class, never a value, and changes nothing", async t => {
  const w = await world(t);
  w.db.prepare("INSERT INTO memory_me_told (ts, text, room, who) VALUES (1, ?, NULL, NULL)").run(`old: ssn ${SSN}`);
  w.db.prepare("INSERT INTO memory_me_told (ts, text, room, who) VALUES (2, ?, NULL, NULL)").run("old: likes tea");
  const before = JSON.stringify(w.db.prepare("SELECT * FROM memory_me_told ORDER BY id").all());
  const direct = scanRows(w.db);
  assert.deepEqual(direct.map(d => [d.table, d.column, d.rows, d.classes]), [["memory_me_told", "text", 1, { "us-ssn": 1 }]]);
  const r = await w.call("memory.sealscan", {}, "deck", await w.session("per_alex"));
  assert.deepEqual(r.data.found, direct);
  assert.doesNotMatch(JSON.stringify(r.data), /123-45|6789/);
  assert.equal(JSON.stringify(w.db.prepare("SELECT * FROM memory_me_told ORDER BY id").all()), before, "reported, not deleted");
});

test("d. no schema change can drop what a person said or decided: corrections, pins, taught facts, agent writes, site rows", () => {
  const PROTECTED = ["memory_corrections", "memory_taught", "memory_writes", "memory_write_links", "memory_me_told", "memory_focus", "memory_site", "memory_site_events", "memory_lessons", "memory_decisions_cursor"];
  const all = MIGRATIONS.join("\n").replace(/--.*$/gm, "");
  for (const table of PROTECTED) {
    assert.doesNotMatch(all, new RegExp(`DROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?${table}\\b`, "i"), `${table} is dropped`);
    assert.doesNotMatch(all, new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, "i"), `${table} is emptied`);
    assert.doesNotMatch(all, new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+DROP`, "i"), `${table} loses a column`);
  }
});

test("d. the tables are still there with their rows after the module starts again on the same database", async t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  for (let i = 0; i < 2; i++) {
    const tools = new Map();
    const ctx = { name: "memory", config: { me: {} }, paths: {}, store: { db, migrate: () => {} }, log: () => {}, events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 }, call: async () => ({ data: [] }), tool: (n, d) => tools.set(n, d), memoryRunner: null };
    const h = await memory.start(ctx);
    if (i === 0) { db.prepare("INSERT INTO memory_me_told (ts, text, room, who) VALUES (1, 'kept', NULL, NULL)").run(); db.prepare("INSERT INTO memory_site (key, kind, rev, record, card, updated) VALUES ('example.com','origin',1,'{}','{}',1)").run(); }
    await h.stop();
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_me_told WHERE text = 'kept'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memory_site").get().n, 1);
});

test("the one Ask door: one to one it reads personal memory AND the Space's, in a room only the Space's, and a room never reaches Recall", async t => {
  const w = await world(t);
  w.space.hits = [{ source: `vyre://${w.rig.space}/matter/m1`, kind: "record", snippet: "matter Doe estate plan, stage Intake" }];
  const solo = await w.rig.k.gateway.grants.chats.create(w.rig.person("per_alex"), {});
  const group = await w.rig.k.gateway.grants.chats.create(w.rig.person("per_alex"), { people: ["per_bob"] });
  // one to one: the pipeline retrieves from Recall as always, and the Space's engine is one more source
  const ts = await w.session("per_alex", { chat: solo.id });
  w.calls.length = 0; w.prompts.length = 0;
  const one = await w.call("memory.ask", { question: "what do we know about the Doe estate plan" }, "deck", ts);
  assert.ok(!one.error, one.error);
  assert.ok(w.calls.includes("recall.search") && w.calls.includes("work.know.search"), w.calls.join());
  assert.match(w.prompts.join("\n"), /Doe estate plan, stage Intake/, "the Space passage was read");
  // a room: only Space memory, narrowed to the room by the engine; personal memory and Recall are never touched
  w.space.answer = { data: { result: { text: "Doe is in Intake [S1]", citations: [`vyre://${w.rig.space}/matter/m1`], withheld: 0 } } };
  const tg = await w.session("per_alex", { chat: group.id });
  w.calls.length = 0; w.prompts.length = 0;
  const room = await w.call("memory.ask", { question: "what do we know about the Doe estate plan" }, "deck", tg);
  assert.ok(!room.error, room.error);
  assert.equal(room.data.via, "space");
  assert.equal(room.data.room, true);
  assert.match(room.data.answer, /Intake/);
  assert.deepEqual(w.calls, ["work.know.answer"], "nothing else was asked: no Recall, no personal facts");
  assert.equal(w.prompts.length, 0, "no personal prompt was built");
  // every other personal tool is still refused in that room
  assert.equal((await w.call("memory.facts", { about: "Harlow" }, "deck", tg)).code, "denied");
});
