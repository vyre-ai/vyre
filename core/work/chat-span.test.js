// @ts-check
// Exact recall: work.chat.span reads a span of a chat word for word, by line range, under the asker's own kernel chain. A person in the chat reads it; an assistant the chat lists reads it; a person who is not in
// the chat is told "no such chat", exactly as for a chat that does not exist, and no word of it reaches them. Sealed values are placeholders (the lines are scrubbed on the way in).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import mod from "./index.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { createRig } from "../../test/kernel-rig.js";

const MEMORY = { name: "work", needs: { kernel: { actions: ["records.read", "records.create", "events.read", "tasks.request"] } } };

async function world(t) {
  const rig = await createRig({ people: { per_bob: "member", per_carol: "member" }, agents: ["juno"], defs: [] });
  const handle = rig.k.kernelFor(MEMORY);
  const db = open(path.join(tempHome(t), "work.db"));
  t.after(() => db.close());
  let asker = rig.person("per_alex");
  const kernel = Object.create(handle, {
    chainFor: { value: () => asker },
    serviceChain: { value: (/** @type {string} */ name) => handle.serviceChain(name) },
    chainForPerson: { value: (/** @type {any} */ p) => rig.withService(rig.person(p.id), "work") },
    chats: { value: rig.k.gateway.grants.chats },
    records: { value: new Proxy({ query: async () => ({ rows: [] }) }, { get: (o, k) => (k in o ? o[k] : async () => ({ id: "rec_x", urn: `vyre://${rig.space}/x/rec_x`, data: {} })) }) },
  });
  const tools = new Map();
  const runs = [];
  await mod.start({ tool: (name, def) => tools.set(name, def), store: { db }, kernel, config: {}, events: { on: () => () => {}, emit: () => {} },
    call: async (tool, input) => { if (tool === "threads.of-chat") return { data: { runs: runs.filter(r => r.chat === input.chat).map(({ chat, ...r }) => r) } }; throw new Error(`unexpected ${tool}`); } });
  const run = (name, input, who) => { asker = who; return tools.get(name).run(input, { caller: "deck" }); };
  return { rig, db, tools, run, runs, as: { alex: rig.person("per_alex"), bob: rig.person("per_bob"), carol: rig.person("per_carol"), juno: rig.assistant("per_alex", "juno") } };
}

test("a span of a chat is read word for word by a person in it and by an assistant it lists; a person outside it gets 'no such chat' and no word", async t => {
  const w = await world(t);
  const alex = w.as.alex;
  const chat = await w.rig.k.gateway.grants.chats.create(alex, { people: ["per_bob"], assistants: ["juno"] });
  w.runs.push({ chat: chat.id, thread: "thr_one", agent: "juno", slot: "agent:juno", provider: "claude", model: "x", status: "idle" });
  // the lines the Space's memory keeps for the run (scrubbed on the way in): the sealed value is already a placeholder
  await w.tools.get("work.know.search").run({ query: "x" }, { caller: "deck" }).catch(() => null);   // starts the Space's memory engine, which makes the lines table
  w.db.exec("CREATE TABLE IF NOT EXISTS memory_engine_lines (session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, trust TEXT NOT NULL, red TEXT NOT NULL, spaces TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (session, seq))");
  const put = (seq, role, text) => w.db.prepare("INSERT OR REPLACE INTO memory_engine_lines VALUES (?,?,?,?,?,?,?,?,?)").run("thr_one", seq, role, text, 1000 + seq, "trusted", "none", "[]", `vyre://${w.rig.space}/session/thr_one`);
  put(1, "user", "Please send the settlement figure to Dana Reyes.");
  put(2, "assistant", "The figure is {{field:vyre://spc/record/r1#amount}} and I will send it today.");
  put(3, "tool", "raw tool output that must never come back");
  put(4, "user", "Thanks, and copy Bob.");
  const ask = (who, input) => w.run("work.chat.span", { chat: chat.id, ...input }, who);
  // a person in the chat: exact words, each with its address, tool output left out, the placeholder kept
  const r = await ask(alex, { from: 1, to: 4 });
  assert.deepEqual(r.runs[0].lines.map(l => [l.seq, l.role, l.text]), [[1, "user", "Please send the settlement figure to Dana Reyes."], [2, "assistant", "The figure is {{field:vyre://spc/record/r1#amount}} and I will send it today."], [4, "user", "Thanks, and copy Bob."]]);
  assert.equal(r.runs[0].lines[0].address, "line:thr_one#1");
  assert.equal(r.sealed, "placeholders");
  // a range inside the span, and a slot filter
  assert.deepEqual((await ask(w.as.bob, { from: 2, to: 2, slot: "agent:juno" })).runs[0].lines.map(l => l.seq), [2]);
  // an assistant the chat lists reads it under its own chain
  assert.equal((await ask(w.as.juno, { from: 1, to: 1 })).runs[0].lines[0].seq, 1);
  // a member of the Space who is NOT in the chat: no such chat, the same refusal as a chat that does not exist
  await assert.rejects(() => ask(w.as.carol, { from: 1, to: 4 }), { code: "not_found", message: "no such chat" });
  await assert.rejects(() => ask(w.as.carol, { chat: "chat_nothere01", from: 1 }).catch(e => { throw e; }), { code: "not_found", message: "no such chat" });
  // an assistant the chat does not list is refused the same way
  const other = w.rig.assistant("per_alex", "kit");
  await assert.rejects(() => ask(other, { from: 1, to: 4 }), { code: "not_found" });
  // bad ranges
  await assert.rejects(() => ask(alex, { from: 5, to: 2 }), { code: "bad_input" });
  await assert.rejects(() => ask(alex, { from: 0, slot: "agent:nobody" }), { code: "not_found" });
  // a run of ANOTHER chat is never read through this one
  w.runs.push({ chat: "chat_other0001", thread: "thr_two", agent: "juno", slot: "agent:juno" });
  w.db.prepare("INSERT OR REPLACE INTO memory_engine_lines VALUES (?,?,?,?,?,?,?,?,?)").run("thr_two", 1, "user", "another chat's words", 1, "trusted", "none", "[]", "r");
  const again = await ask(alex, { from: 1, to: 1 });
  assert.equal(JSON.stringify(again).includes("another chat's words"), false);
});
