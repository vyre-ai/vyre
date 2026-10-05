// @ts-check
// A planner on a fake clock over a real kernel, for the tests that read and write the Space's records (events.test.js, records.test.js): the module started as the daemon starts it
// (ctx.kernel from kernelFor), a hand-driven timer, and the person's own chain for the writes a connector or the app would make.

import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import planner, { seams } from "./index.js";
import { createKernel } from "../../kernel/index.js";
import { CORE_TYPES } from "../../records/core-types.js";
import { Events } from "../../kernel/bus.js";
import { callerAllowed } from "../modules/index.js";

export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
export const Z = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);
export const T0 = Z(2026, 9, 24, 5); // Thursday 10:00 in Karachi
export const iso = ms => new Date(ms).toISOString();
export const SPACE = "spc_aaaaaaaaaaaa"; export const OWNER = "per_owner";
const NEEDS = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).needs;
export const FACTS = { kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" };
let homes = 0;

/** The google module, only for the one call the planner still makes of it: an event written on a connected account. */
export const fakeGoogle = () => {
  const g = { calls: /** @type {any[]} */ ([]), held: /** @type {any[]} */ ([]), seq: 0,
    async call(/** @type {string} */ tool, /** @type {any} */ input) {
      g.calls.push([tool, input]);
      if (tool === "google.calendar.create") {
        const to = [].concat(input.attendees || []).filter(Boolean);
        if (to.length) { const id = `g_${++g.seq}`; g.held.push({ id, to, input }); return { data: { held: id, message: `Held at the Gate: the invite goes to ${to.join(", ")} once the user approves it in Vyre. Nothing was created yet.` } }; }
        return { data: { event: { id: `ev_${++g.seq}`, account: input.account, title: input.title, start: input.start } } };
      }
      return { error: { code: "no_such_tool", message: `no tool ${tool}` } };
    } };
  return g;
};

export async function world(t, { tz = "Asia/Karachi", start = T0, google = fakeGoogle(), kernel = null } = {}) {
  const k = kernel || await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4) });
  const owner = k.chains.fromFacts(FACTS);
  if (!kernel) await k.gateway.records.define(owner, { add_types: CORE_TYPES.filter(c => c.name === "event") });
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  const events = new Events(db);
  const root = `/planner-ev-test-${++homes}`;
  const clock = { t: start };
  /** @type {Map<number, { at: number, ms: number, fn: () => void }>} */
  const timers = new Map();
  let seq = 0;
  seams.set(root, { now: () => clock.t, setTimer: (fn, ms) => { timers.set(++seq, { at: clock.t + ms, ms, fn }); return seq; }, clearTimer: id => timers.delete(id) });
  t.after(() => seams.delete(root));
  const fired = [], acked = [];
  events.on("planner.fired", e => fired.push({ at: clock.t, ...e.payload }));
  events.on("planner.acked", e => acked.push(e.payload));
  /** @type {Map<string, any>} */
  const tools = new Map();
  const ctx = {
    name: "planner", config: { role: "box", planner: { timezone: tz } }, paths: { root }, kernel: k.kernelFor({ name: "planner", needs: NEEDS }),
    log: () => {},
    events: { emit: (type, p, where) => events.emit("planner", type, p, where), on: (p, fn) => events.on(p, fn), latestId: () => events.latestId() },
    tool: (name, def) => tools.set(name, def),
    call: async (tool, input) => google.call(tool, input),
    remote: async () => ({ error: { code: "no_link", message: "no link" } }),
  };
  const handle = await planner.start(ctx);
  t.after(() => handle.stop());
  const R = k.gateway.records;
  const w = {
    k, events, clock, timers, fired, acked, google, handle, owner,
    settled: () => handle.calendar.settled(),
    async call(name, input = {}, caller = "cli") {
      const def = tools.get(name);
      if (!def) return { error: { code: "no_such_tool" } };
      if (!callerAllowed(def.callers, caller)) return { error: { code: "denied", message: `${name} is not for ${caller}` } };
      const facts = ["cli", "local", "deck", "capsule"].includes(caller) ? { kernelFacts: FACTS } : {};
      try { return { data: await def.run(input, { caller, ...facts }) }; }
      catch (e) { const err = /** @type {any} */ (e); return { error: { code: err.code || "failed", message: err.message } }; }
    },
    async ok(name, input = {}, caller = "cli") {
      const r = await w.call(name, input, caller);
      assert.ok(!r.error, `${name}: ${JSON.stringify(r.error)}`);
      return r.data;
    },
    /** Move the clock on, running each timer as its moment comes, and let a read it starts finish. */
    async advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        clock.t = next[1].at;
        next[1].fn();
        await handle.calendar.settled();
      }
      clock.t = end;
    },
    /** What a connector's sync does: write an Event record as the person. */
    async put(/** @type {any} */ data) {
      const d = { source: "google", calendar: "alex", all_day: false, ...data, ...(data.start ? { starts_at: data.start } : {}), ...(data.end ? { ends_at: data.end } : {}) };
      delete d.start; delete d.end;
      return R.create(owner, "event", { external_id: `x_${Math.random().toString(36).slice(2, 8)}`, ...d });
    },
    async patch(/** @type {any} */ rec, /** @type {any} */ data) { return R.update(owner, "event", rec.id, data, (await R.get(owner, "event", rec.id)).version); },
    async drop(/** @type {any} */ rec) { return R.remove(owner, "event", rec.id, (await R.get(owner, "event", rec.id)).version); },
    /** Read the records again (the explicit form of what the kernel's events do on their own). */
    read: async () => { const r = await w.ok("planner.calendar.sync"); await w.settled(); return r; },
  };
  await w.settled();
  return w;
}

