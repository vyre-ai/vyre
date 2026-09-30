// @ts-check
// spend: the ledger and the per-provider daily cap. At the cap the spending thread pauses with one line
// and a raise-it action, once a day, and nothing asks on a call. Fictional data only (juno, kit).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import spend, { capLine } from "./index.js";

const DAY = Date.parse("2026-09-30T10:00:00Z");

async function world(t, caps = { claude: 5 }) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  db.exec("CREATE TABLE threads_runs (id TEXT PRIMARY KEY, agent TEXT)");
  db.prepare("INSERT INTO threads_runs (id, agent) VALUES ('t1', 'juno')").run();
  const tools = new Map(), handlers = [], emitted = [], halted = [], settings = { ...caps };
  const clock = { now: DAY };
  const ctx = {
    name: "spend", config: {}, store: { db, migrate: m => migrate(db, "spend", m) }, now: () => clock.now,
    events: { on: (type, fn) => { handlers.push([type, fn]); return () => {}; }, emit: (type, payload) => emitted.push({ type, payload }) },
    call: async (tool, input) => {
      if (tool === "settings.get") return { value: settings[String(input.key).split(".")[1]] };
      if (tool === "settings.write") { const p = String(input.key).split(".")[1]; if (input.value === undefined) delete settings[p]; else settings[p] = input.value; return {}; }
      if (tool === "threads.halt") { halted.push(input); return {}; }
      throw new Error(`no ${tool}`);
    },
    tool: (name, def) => tools.set(name, def),
  };
  const h = await spend.start(ctx);
  t.after(() => h.stop());
  const call = async (name, input = {}, caller = "cli", meta = {}) => {
    try { return { data: await tools.get(name).run(input, { caller, ...meta }) }; } catch (e) { return { error: e.message, code: e.code }; }
  };
  const fin = (thread, cost) => Promise.all(handlers.filter(([ty]) => ty === "thread.finished").map(([, fn]) => fn({ thread, payload: { cost_usd: cost, tokens: { input: 100, output: 20 } } })));
  return { call, emitted, halted, settings, clock, fin };
}
const FP = { firstParty: true };

test("spend: a record adds up per day and provider; below the cap nothing is said", async t => {
  const w = await world(t);
  assert.equal((await w.call("spend.record", { provider: "claude", purpose: "memory.ask", usd: 1.5 }, "module:memory", FP)).data.capped, false);
  await w.call("spend.record", { provider: "claude", purpose: "memory.read", usd: 0.5, tokens_in: 1000, tokens_out: 200 }, "module:memory", FP);
  const s = (await w.call("spend.summary")).data;
  assert.equal(s.day, "2026-09-30");
  assert.deepEqual(s.providers.map(p => [p.provider, p.spent, p.cap, p.left, p.capped, p.calls]), [["claude", 2, 5, 3, false, 2]]);
  assert.equal(w.emitted.length, 0);
  assert.equal((await w.call("spend.check", { provider: "claude" })).data.ok, true);
  assert.equal((await w.call("spend.check", { provider: "codex" })).data.cap, null, "no cap set means ok");
});

test("spend: reaching the cap pauses the spending thread once, with one line and a raise-it action", async t => {
  const w = await world(t);
  await w.fin("t1", 4.9);
  assert.equal(w.halted.length, 0);
  await w.fin("t1", 0.3);
  assert.equal(w.halted.length, 1);
  assert.equal(w.halted[0].thread, "t1");
  assert.equal(w.halted[0].reason, "spend");
  assert.equal(w.halted[0].text, capLine("claude", 5.2, 5, "juno"));
  assert.match(w.halted[0].text, /Raise it: vyre spend raise claude/);
  const caps = w.emitted.filter(e => e.type === "spend.capped");
  assert.equal(caps.length, 1);
  assert.equal(caps[0].payload.agent, "juno");
  assert.deepEqual(caps[0].payload.action, { label: "Raise it", tool: "spend.raise", input: { provider: "claude", to: 10 } });
  // Another turn past the cap halts again but does not say it again the same day.
  await w.fin("t1", 0.1);
  assert.equal(w.halted.length, 2);
  assert.equal(w.emitted.filter(e => e.type === "spend.capped").length, 1);
  const c = (await w.call("spend.check", { provider: "claude" })).data;
  assert.equal(c.ok, false);
  assert.equal(c.left, 0);
  assert.match(c.line, /daily cap/);
});

test("spend: raising the cap lets work go on, and the new cap says so when reached; tomorrow starts at zero", async t => {
  const w = await world(t);
  await w.fin("t1", 5.5);
  assert.equal((await w.call("spend.check", {})).data.capped, true);
  const r = await w.call("spend.raise", { provider: "claude", to: 10 });
  assert.deepEqual([r.data.cap, r.data.was], [10, 5]);
  assert.equal(w.settings.claude, 10);
  assert.equal((await w.call("spend.check", {})).data.ok, true);
  await w.fin("t1", 5);
  assert.equal(w.emitted.filter(e => e.type === "spend.capped").length, 2, "reached again at the new cap");
  assert.equal((await w.call("spend.raise", { provider: "claude", by: 5 })).data.cap, 15);
  assert.equal((await w.call("spend.raise", { provider: "claude", off: true })).data.cap, null);
  assert.equal((await w.call("spend.check", {})).data.cap, null);
  w.settings.claude = 10;
  w.clock.now += 24 * 3_600_000;
  assert.equal((await w.call("spend.check", {})).data.spent, 0, "a new UTC day");
});

test("spend: only Vyre's own modules record, bad input is refused, nothing spends without a cost", async t => {
  const w = await world(t);
  for (const [caller, meta] of [["cli", {}], ["mcp", {}], ["module:bakery", {}], ["module:bakery", { firstParty: false }]]) {
    assert.equal((await w.call("spend.record", { purpose: "x", usd: 99 }, caller, meta)).code, "denied", caller);
  }
  assert.equal((await w.call("spend.raise", { provider: "claude" })).code, "bad_input");
  assert.equal((await w.call("spend.raise", { provider: "claude", to: -1 })).code, "bad_input");
  assert.equal((await w.call("spend.check", { provider: "Bad Name!" })).code, "bad_input");
  await w.fin("t1", 0);
  assert.equal((await w.call("spend.summary")).data.providers.length, 0);
  assert.equal(w.halted.length, 0);
});

test("spend: a provider with no setting of its own shares the other-providers cap", async t => {
  const w = await world(t, { other: 1 });
  await w.call("spend.record", { provider: "openrouter", purpose: "x", usd: 0.4 }, "module:memory", FP);
  assert.equal((await w.call("spend.check", { provider: "openrouter" })).data.cap, 1);
  await w.call("spend.record", { provider: "openrouter", purpose: "x", thread: "t1", usd: 0.7 }, "module:memory", FP);
  assert.equal(w.halted.length, 1);
  assert.equal((await w.call("spend.check", { provider: "claude" })).data.cap, null, "claude has its own setting, unset");
  assert.equal((await w.call("spend.raise", { provider: "openrouter", to: 5 })).data.cap, 5);
  assert.equal(w.settings.other, 5);
});

test("spend: an agent, module or automation is held at a provider's cap before a thread starts or takes a send; the person never is", async () => {
  const { spendCheck } = await import("../switchboard/index.js");
  const capped = { call: async () => ({ data: { capped: true, line: "Claude spend today reached $5.00 of the $5.00 daily cap, so this is paused. Raise it: vyre spend raise claude <dollars>" } }) };
  const open_ = { call: async () => ({ data: { capped: false } }) };
  for (const who of ["mcp", "mcp:agent:juno", "module:agents", "module:planner", "harness:agent:kit", "hook"]) {
    await assert.rejects(() => spendCheck(capped, who, "claude"), e => e.code === "spend_capped" && /Raise it/.test(e.message), who);
    await spendCheck(open_, who, "claude");
  }
  for (const who of ["cli", "deck", "capsule", "local", "tailnet:phone"]) await spendCheck(capped, who, "claude");
  await spendCheck({ call: async () => { throw new Error("no spend module"); } }, "module:agents", "claude");
  await spendCheck({ call: async () => ({ error: { code: "no_such_tool" } }) }, "module:agents", "claude");
});
