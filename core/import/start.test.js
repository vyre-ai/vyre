// @ts-check
// import.start / stop / cancel: the person's consent goes to the server through federation's
// door, the plan's sessions go through federation's sender a batch at a time, and nothing is ever
// deleted unless the person asks. The import module against a stand-in for core/sync.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import mod from "./index.js";

function sessions(root, n) {
  const dir = path.join(root, "claude", "projects", "-home-alex-Work-harlow-site");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) {
    const id = `22222222-0000-4000-8000-${String(i).padStart(12, "0")}`;
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: "user", cwd: "/home/alex/Work/harlow-site", message: { content: `turn ${i}` } }) + "\n");
  }
}

async function world(t, { n = 30, sync = true } = {}) {
  const root = tempHome(t);
  sessions(root, n);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const tools = new Map(), calls = [];
  const fake = {
    "sync.consent": i => ({ ok: true, ...i }),
    "sync.send": i => ({ sent: i.files.length, failed: 0, quarantined: i.files.filter(f => f.rel.endsWith("7.jsonl")).length, of: i.files.length, skipped: 0 }),
    "sync.delete": i => ({ deleted: true, ...i }),
    "memory.pace": i => i,
    "projects.list": () => ({ projects: [] }),
    "recall.status": () => ({ sessions: 0, turns: 0 }), "memory.stats": () => ({}),
  };
  const ctx = {
    name: "import", config: { name: "Alex MacBook", transcripts: [path.join(root, "claude", "projects")] }, paths: { root },
    store: { db, migrate: steps => migrate(db, "import", steps) }, log: () => {},
    events: { on: () => () => {}, emit: () => {} },
    call: async (tool, input) => { calls.push({ tool, input }); if (tool.startsWith("sync.") && !sync) return { error: { code: "no_such_tool", message: tool } }; const f = fake[tool]; return f ? { data: await f(input) } : { error: { code: "no_such_tool", message: tool } }; },
    tool: (name, def) => tools.set(name, def),
  };
  const h = await mod.start(ctx);
  t.after(() => h.stop());
  const call = async (name, input, caller = "deck", meta = {}) => { try { return { data: await tools.get(name).run(input, { ...meta, caller }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; } };
  return { call, calls, db, root };
}

const settle = async (call, run) => { for (let i = 0; i < 100; i++) { const s = (await call("import.status", {})).data.upload; if (s && s.state !== "sending") return s; await new Promise(r => setTimeout(r, 20)); } throw new Error(`import ${run} never finished`); };

test("import.start: consent through core/sync, then the plan's sessions in batches, with quarantines counted", async t => {
  const { call, calls } = await world(t);
  await call("import.scan", {});
  const p = (await call("import.plan", { include: ["/home/alex/Work"] })).data;
  assert.equal(p.sessions, 30);
  // Only the person: never a model or an agent, and never a device nobody signed in on.
  for (const [c, meta] of [["mcp", {}], ["deck agent:kit", {}], ["tailnet:alex@example.com", {}]]) assert.equal((await call("import.start", { plan: p.plan, mode: "once", pace: "gentle" }, c, meta)).code, "denied", c);
  const r = await call("import.start", { plan: p.plan, mode: "once", pace: "fast" });
  assert.ok(r.data?.run, JSON.stringify(r));
  assert.deepEqual([r.data.sessions, r.data.mode, r.data.pace], [30, "once", "fast"]);
  const up = await settle(call, r.data.run);
  assert.deepEqual([up.done, up.total, up.failed, up.quarantined, up.state], [30, 30, 0, 3, "done"]);
  const consent = calls.find(c => c.tool === "sync.consent");
  assert.deepEqual([consent.input.machine, consent.input.on, consent.input.mode], ["alex-macbook", true, "once"]);
  assert.match(consent.input.plan, /^[0-9a-f]{64}$/, "the consent carries the plan's hash");
  const sends = calls.filter(c => c.tool === "sync.send");
  assert.deepEqual(sends.map(s => s.input.files.length), [25, 5], "a batch at a time");
  const f = sends[0].input.files[0];
  assert.deepEqual(Object.keys(f).sort(), ["bytes", "hash", "path", "rel"]);
  assert.match(f.rel, /^-home-alex-Work-harlow-site\/22222222-0000-4000-8000-\d{12}\.jsonl$/, "Claude Code's own layout under synced/<machine>/");
  assert.match(f.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(calls.filter(c => c.tool === "memory.pace").map(c => c.input), [{ pace: "fast" }], "a pace, never a paid allowance");
  // A plan is used once; a spent or unknown one is refused.
  assert.equal((await call("import.start", { plan: p.plan, mode: "once", pace: "fast" })).code, "not_found");
});

test("import.stop and cancel: neither ever deletes what was sent", async t => {
  const { call, calls } = await world(t, { n: 5 });
  await call("import.scan", {});
  const p = (await call("import.plan", { include: ["/home/alex/Work"] })).data;
  await call("import.start", { plan: p.plan, mode: "sync", pace: "gentle" });
  const stop = await call("import.stop", {});
  assert.ok(!stop.error, JSON.stringify(stop));
  assert.ok(calls.some(c => c.tool === "sync.consent" && c.input.on === false), "sync turned off");
  assert.deepEqual((await call("import.cancel", {})).data, { stopped: false, dropped: false });
  assert.equal((await call("import.cancel", {}, "mcp")).code, "denied");
  assert.ok(!calls.some(c => c.tool === "sync.delete"), "a stop or a cancel deleted");
});

test("import.start: with no server to send to, it says so and sends nothing", async t => {
  const { call, calls } = await world(t, { n: 2, sync: false });
  await call("import.scan", {});
  const p = (await call("import.plan", { include: ["/home/alex/Work"] })).data;
  const r = await call("import.start", { plan: p.plan, mode: "once", pace: "gentle" });
  assert.equal(r.code, "unavailable", JSON.stringify(r));
  assert.ok(!calls.some(c => c.tool === "sync.send"));
});
