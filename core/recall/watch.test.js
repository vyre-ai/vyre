// @ts-check
// recall.watch: a live tail of a session's transcript as session.turn events, in a registry with
// only the recall module and a temp transcript that the test appends to.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID = "44444444-dddd-4000-8000-000000000004";
const CWD = "/home/alex/Work/northwind-bakery";
const TOKEN = "rk_test_" + "NorthwindBakery0000fake34";

let clock = Date.parse("2026-09-06T09:00:00Z");
const ts = () => new Date(clock += 1000).toISOString();
const U = text => ({ type: "user", timestamp: ts(), cwd: CWD, sessionId: ID, message: { role: "user", content: text } });
const A = (id, part) => ({ type: "assistant", timestamp: ts(), cwd: CWD, sessionId: ID, message: { id, role: "assistant", model: "m", content: [part], usage: { input_tokens: 1, output_tokens: 1 } } });
const R = (id, content) => ({ type: "user", timestamp: ts(), cwd: CWD, sessionId: ID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content }] } });
const jsonl = lines => lines.map(l => JSON.stringify(l) + "\n").join("");

async function world(t, recall = {}, lines = [U("Check the Northwind Bakery order form"), A("m0", { type: "text", text: "On it." })]) {
  const root = tempHome(t);
  const p = config.ensure(root);
  const dir = path.join(root, "transcripts", "-home-alex-Work-northwind-bakery");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ID}.jsonl`);
  fs.writeFileSync(file, jsonl(lines));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local", transcripts: [path.join(root, "transcripts")], recall: { every: 0, vectors: false, ...recall } }, paths: p, log: () => {} });
  await reg.start(discover([CORE]).filter(f => f.manifest && f.manifest.name === "recall"), { role: "local" });
  t.after(async () => { await reg.stop(); db.close(); });
  assert.equal(reg.modules.get("recall")?.state, "running", reg.modules.get("recall")?.error);
  /** @type {any[]} */
  const seen = [];
  events.on("session.*", e => seen.push(e));
  const call = async (tool, input, caller = "deck") => {
    const r = await reg.call(tool, input, caller);
    if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.code} ${r.error.message}`), { code: r.error.code });
    return r.data;
  };
  return { reg, file, seen, call, append: (/** @type {any[]} */ ls) => fs.appendFileSync(file, jsonl(ls)) };
}

async function until(/** @type {() => boolean} */ ok, ms = 4000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 20));
  }
}
const turns = seen => seen.filter(e => e.type === "session.turn").map(e => e.payload);

test("recall.watch: appended lines arrive as session.turn events, redacted, with busy state", async t => {
  const w = await world(t);
  const r = await w.call("recall.watch", { session: ID });
  assert.match(r.watch, /^w_[0-9a-f]{16}$/);
  assert.deepEqual({ ...r, watch: 0 }, { watch: 0, session: ID, from: null, busy: false });
  assert.equal(turns(w.seen).length, 0, "without from, nothing old is sent");

  w.append([U(`Deploy it. The key is ${TOKEN}`)]);
  w.append([A("m1", { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: `STRIPE_KEY=${TOKEN} npm run deploy` } })]);
  await until(() => turns(w.seen).length >= 2);
  w.append([R("toolu_1", "deployed"), A("m2", { type: "text", text: "Deployed the Northwind Bakery site." })]);
  await until(() => turns(w.seen).length >= 3 && w.seen.some(e => e.type === "session.state" && e.payload.busy === false));

  const ev = w.seen.filter(e => e.type === "session.turn");
  assert.ok(ev.every(e => e.thread === ID && e.source === "recall"), "the event's thread is the session");
  assert.deepEqual(ev.map(e => [e.payload.id, e.payload.role, e.payload.seq]), [["2", "user", 2], ["tool:toolu_1", "tool", 3], ["3", "assistant", 5]]);
  assert.equal(ev[0].payload.turn, 2);
  assert.match(ev[0].payload.text, /\[Stripe key redacted …ke34\]/);
  assert.equal(ev[1].payload.tool.name, "Bash");
  assert.equal(ev[1].payload.text, ev[1].payload.tool.summary);
  assert.ok(!JSON.stringify(w.seen).includes("NorthwindBakery0000fake"), "a key reached an event");
  assert.ok(!JSON.stringify(ev[1].payload).includes("deployed\""), "a tool's output reached an event");
  assert.equal(typeof ev[2].payload.at, "number");
  const states = w.seen.filter(e => e.type === "session.state").map(e => e.payload.busy);
  assert.deepEqual(states, [true, false]);

  // A half-written line waits for the rest of it.
  const half = JSON.stringify(U("and one more thing"));
  fs.appendFileSync(w.file, half.slice(0, 20));
  await new Promise(r => setTimeout(r, 150));
  assert.equal(turns(w.seen).length, 3);
  fs.appendFileSync(w.file, half.slice(20) + "\n");
  await until(() => turns(w.seen).length === 4);
  assert.equal(turns(w.seen)[3].text, "and one more thing");

  // History and live share their fields: a thread item's id is its seq, and it has at.
  await w.call("recall.index", {});
  const th = await w.call("recall.thread", { session: ID });
  assert.deepEqual(th.turns.map(x => x.id), ["0", "1", "2", "3", "4"]);
  assert.equal(th.turns[2].text, ev[0].payload.text);
  assert.equal(th.turns[2].at, th.turns[2].ts);
});

test("recall.watch: from replays the turns after it, marked with the watch", async t => {
  const w = await world(t, {}, [U("Fix the Harlow Legal intake"), A("m0", { type: "thinking", thinking: "look first" }),
    A("m0", { type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: "/home/alex/Work/harlow/intake.js" } }),
    R("toolu_r", "the file"), A("m1", { type: "text", text: "Fixed." })]);
  await w.call("recall.index", {}); // a prefix, as recall.thread takes, needs the session indexed
  const r = await w.call("recall.watch", { session: ID.slice(0, 12), from: "0" });
  assert.equal(r.from, "0");
  const ev = turns(w.seen);
  assert.deepEqual(ev.map(p => p.id), ["tool:toolu_r", "1"]);
  assert.ok(ev.every(p => p.replay === r.watch));
  assert.equal(ev[0].text, "Read /home/alex/Work/harlow/intake.js");
  const again = await w.call("recall.watch", { session: ID, from: "tool:toolu_r" });
  assert.deepEqual(turns(w.seen).filter(p => p.replay === again.watch).map(p => p.id), ["1"], "a second watcher replays too, sharing the file");
  const unknown = await w.call("recall.watch", { session: ID, from: "99" });
  assert.equal(unknown.from, null, "a turn id the session does not have replays nothing");
});

test("recall.watch: watchers share one fs.watch, and unwatching the last closes it", async t => {
  const w = await world(t);
  const a = await w.call("recall.watch", { session: ID });
  const b = await w.call("recall.watch", { session: ID });
  assert.notEqual(a.watch, b.watch);
  assert.deepEqual((await w.call("recall.status", {})).watches, { files: 1, watches: 2, watching: 1 });
  await w.call("recall.unwatch", { watch: a.watch });
  assert.deepEqual((await w.call("recall.status", {})).watches, { files: 1, watches: 1, watching: 1 });
  await w.call("recall.unwatch", { watch: b.watch });
  assert.deepEqual((await w.call("recall.status", {})).watches, { files: 0, watches: 0, watching: 0 });
  w.append([U("nobody is watching now")]);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(turns(w.seen).length, 0);
  await assert.rejects(w.call("recall.unwatch", { watch: b.watch }), /not_found/);
});

test("recall.watch: a watch nobody renews expires; renewing keeps it", async t => {
  const w = await world(t, { watchSweepMs: 30, watchTtlMs: 250, watchIdleMs: 60_000 });
  const a = await w.call("recall.watch", { session: ID });
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 100));
    const again = await w.call("recall.watch", { session: ID, watch: a.watch });
    assert.equal(again.watch, a.watch);
    assert.equal(again.renewed, true);
  }
  assert.equal((await w.call("recall.status", {})).watches.watches, 1, "a renewed watch expired");
  const end = Date.now() + 2000;
  while ((await w.call("recall.status", {})).watches.watches && Date.now() < end) await new Promise(r => setTimeout(r, 30));
  assert.deepEqual((await w.call("recall.status", {})).watches, { files: 0, watches: 0, watching: 0 });
});

test("recall.watch: a session quiet past the idle time ends its watch", async t => {
  const w = await world(t, { watchSweepMs: 30, watchTtlMs: 60_000, watchIdleMs: 250 });
  await w.call("recall.watch", { session: ID });
  const end = Date.now() + 2000;
  while ((await w.call("recall.status", {})).watches.watches && Date.now() < end) await new Promise(r => setTimeout(r, 30));
  assert.equal((await w.call("recall.status", {})).watches.watches, 0);
});

test("recall.watch: a person's surfaces only, and an unknown session is not_found", async t => {
  const w = await world(t);
  for (const caller of ["guest:someone@example.com", "mcp", "mcp:agent:kit"]) {
    for (const [tool, input] of [["recall.watch", { session: ID }], ["recall.unwatch", { watch: "w_0" }]]) {
      const r = await w.reg.call(tool, input, caller);
      assert.ok(["denied", "no_such_tool"].includes(r.error?.code), `${caller} used ${tool}`);
    }
  }
  for (const caller of ["cli", "local", "capsule", "device:nw3b43olz4rzbzfe"]) {
    const r = await w.reg.call("recall.watch", { session: ID }, caller);
    assert.ok(r.data?.watch, `${caller}: ${JSON.stringify(r.error)}`);
  }
  await assert.rejects(w.call("recall.watch", { session: "55555555-eeee-4000-8000-000000000005" }), /not_found/);
});
