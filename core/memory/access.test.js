// @ts-check
// Reads for a thread, the user's other devices, and corrections asking no presence
// (docs/adr/0007-intelligence.md, decision 4; ADR 0004). The memory module against a stand-in
// for vyred, over the shared fictional corpus.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { SESSIONS, HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import memory from "./index.js";

const W = `${HOME}/Work`;
const SITE = SESSIONS[0].id, NORTHWIND = SESSIONS[2].id, PLANNING = SESSIONS[3].id;
const WORKS = "name:Dana Reyes|works_at|name:Harlow Legal";
const PROJECTS = [
  { slug: "harlow", name: "Harlow Legal", home: `${W}/harlow-site`, workspaces: [`${W}/harlow-intake`], threads: 3, picked: 1, picks: [PLANNING] },
  { slug: "northwind", name: "Northwind", home: `${W}/northwind`, workspaces: [], threads: 3, picked: 1, picks: [PLANNING] },
];
const AGENTS = [{ name: "kit", projects: ["northwind"] }, { name: "hal", projects: ["harlow"] }];
const TAILNET = "tailnet:alex@example.com";

async function module_(t) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  const tools = new Map();
  const ctx = {
    name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async tool => tool === "projects.list" ? { data: { projects: PROJECTS } } : tool === "agents.list" ? { data: AGENTS } : { error: { code: "no_such_tool", message: tool } },
    tool: (name, def) => tools.set(name, def),
  };
  const handle = await memory.start(ctx);
  t.after(() => handle.stop());
  /** A tool's answer, or { error, code } as vyred would pass them on. */
  const call = async (name, input, caller) => {
    try { return { data: await tools.get(name).run(input, { caller }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; }
  };
  await call("memory.curate", {}, "cli");
  return { call, tools, db };
}

test("facts by thread: what a thread's turns support, with the turns, in the main graph or a room", async t => {
  const { call, db } = await module_(t);
  const r = await call("memory.facts", { thread: SITE }, "deck");
  assert.ok(!r.error, r.error);
  assert.equal(r.data.thread, SITE);
  assert.equal(r.data.room, "*");
  const works = r.data.facts.find(f => f.id === WORKS);
  assert.ok(works, r.data.facts.map(f => f.id).join("\n"));
  assert.equal(works.text, "Dana Reyes works at Harlow Legal");
  assert.ok(Array.isArray(works.taught));
  const turns = new Set(db.prepare("SELECT seq FROM recall_turns WHERE session = ?").all(SITE).map(x => Number(x.seq)));
  for (const f of r.data.facts) {
    assert.notEqual(f.rel, "mentioned_in");
    assert.ok(f.refs.length > 0 && f.refs.every(x => Object.keys(x).join() === "seq" && turns.has(x.seq)), `${f.id}: ${JSON.stringify(f.refs)}`);
    // Every ref is a turn memory holds as evidence for that fact in this thread.
    const ev = db.prepare("SELECT v.seq FROM memory_evidence v JOIN memory_edges e ON e.id = v.edge WHERE e.room = '*' AND e.src || '|' || e.rel || '|' || e.dst = ? AND v.session = ?").all(f.id, SITE).map(x => Number(x.seq));
    assert.deepEqual(f.refs.map(x => x.seq), ev.sort((a, b) => a - b));
  }
  // The refs are in turn order, and facts come in the order their first turn does.
  const firsts = r.data.facts.map(f => f.refs[0].seq);
  assert.deepEqual(firsts, [...firsts].sort((a, b) => a - b));
  assert.equal((await call("memory.facts", { thread: SITE, limit: 1 }, "deck")).data.facts.length, 1);

  // In a room: that room's rows. A thread from another room supports nothing here.
  const room = await call("memory.facts", { thread: SITE, room: "harlow" }, "mcp");
  assert.ok(!room.error, room.error);
  assert.equal(room.data.room, "harlow");
  assert.ok(room.data.facts.some(f => f.id === WORKS));
  assert.deepEqual((await call("memory.facts", { thread: NORTHWIND, room: "harlow" }, "mcp")).data.facts, []);
  // The picked hub thread counts in Northwind only for what Northwind knows.
  const hub = await call("memory.facts", { thread: PLANNING, room: "northwind" }, "deck");
  assert.ok(!hub.error, hub.error);
  assert.ok(!hub.data.facts.some(f => /Harlow|Dana/.test(f.text)), hub.data.facts.map(f => f.text).join("\n"));
});

test("facts by thread: the same access rules as every other read", async t => {
  const { call } = await module_(t);
  // A session with no room gets no main graph; an agent reads only its granted rooms.
  for (const [input, caller] of [[{ thread: SITE }, "mcp"], [{ thread: SITE }, "mcp:agent:hal"], [{ thread: SITE, room: "harlow" }, "mcp:agent:kit"],
    [{ thread: SITE, room: "unfiled" }, "mcp:agent:hal"]]) {
    const r = await call("memory.facts", input, caller);
    assert.equal(r.code, "denied", `${JSON.stringify(input)} from ${caller}: ${JSON.stringify(r)}`);
  }
  const hal = await call("memory.facts", { thread: SITE, room: "harlow" }, "mcp:agent:hal");
  assert.ok(!hal.error && hal.data.facts.length > 0, hal.error);
  assert.match((await call("memory.facts", { thread: SITE, about: "Dana" }, "deck")).error || "", /thread is read on its own/);
});

test("tailnet: the user's other devices read as the owner, and never correct", async t => {
  const { call } = await module_(t);
  for (const [tool, input] of [["memory.graph", {}], ["memory.facts", { about: "Dana Reyes" }], ["memory.facts", { thread: SITE }],
    ["memory.why", { fact: WORKS }], ["memory.stats", {}], ["memory.corrections", {}]]) {
    const r = await call(tool, input, TAILNET);
    assert.ok(!r.error, `${tool}: ${r.error}`);
  }
  assert.equal((await call("memory.graph", {}, TAILNET)).data.scope, "main");
  for (const [tool, input] of [["memory.correct", { fact: WORKS, action: "wrong" }], ["memory.merge", { node: "Dana Reyes", into: "Sam Okafor" }],
    ["memory.split", { node: "Dana Reyes", other: "Sam Okafor" }], ["memory.uncorrect", { id: 1 }]]) {
    const r = await call(tool, input, TAILNET);
    assert.equal(r.code, "denied", `${tool}: ${JSON.stringify(r)}`);
  }
  // Find on the owner's phone searches memory by meaning, account-wide, as the Deck does.
  const rel = await call("memory.relevant", { text: "email Dana Reyes" }, TAILNET);
  assert.ok(!rel.error && !rel.code, `memory.relevant: ${JSON.stringify(rel)}`);
  assert.equal((await call("memory.relevant", { text: "email Dana Reyes" }, "tailnet:")).code, "denied", "not a login");
  // A caller that merely looks like one, or names an agent, is not the owner.
  // An agent's own tailnet node, and a guest from another tailnet, are not the user either.
  for (const caller of ["tailnet:", "xtailnet:alex@example.com", "mcp tailnet:alex", "tailnet:agent:kit", "tailnet-guest:sam@harlow.example"]) assert.equal((await call("memory.stats", {}, caller)).code, "denied", caller);
  assert.equal((await call("memory.corrections", {}, "tailnet:alex@example.com agent:kit")).code, "denied");
  assert.equal((await call("memory.corrections", {}, "mcp")).code, "denied");
});

test("presence: correct, merge and split are the user's own, with no prompt; agents stay refused", async t => {
  const { tools, call } = await module_(t);
  for (const tool of ["memory.correct", "memory.merge", "memory.split"]) assert.equal(tools.get(tool).presence, undefined, `${tool} asks for presence`);
  // The allowlist and the agent refusal stay, and refusals carry a code.
  for (const tool of ["memory.correct", "memory.merge", "memory.split"]) assert.deepEqual(tools.get(tool).callers, ["deck", "cli", "local", "capsule"]);
  assert.equal((await call("memory.correct", { fact: WORKS, action: "wrong" }, "deck agent:kit")).code, "denied");
});
