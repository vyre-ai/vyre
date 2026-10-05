// @ts-check
// The Capsule path (ADR 0025 point 1): a Mac paired with a box forwards the planner to the box,
// keeps its own scheduler idle, and hears the box's rings on /v1/link/events. A box vyred and a
// Mac vyred run in one process on the link's test harness; the box's planner runs on a fake clock
// with a hand-driven timer, so the alarm rings the moment the test says, not after a real wait.

import "../../scripts/mac-test-guard.mjs";
// The planner keeps its things in the Space's records, so these homes run with the kernel on, as core/memory's daemon tests do.
process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { seams } from "./index.js";
import { paths } from "../config/index.js";
import { pair, until, wait } from "../../test/link-harness.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 9, 0); // a whole minute, so a floating alarm's wall time is exact

/**
 * The planner's seams are keyed by a home that pair() makes itself, so pick them by the role the
 * home's config names: the box gets the fake clock and timer, the Mac a timer that only counts.
 */
function fakeClocks(t) {
  const clock = { t: T0 };
  /** @type {Map<number, { at: number, ms: number, fn: () => void }>} */
  const timers = new Map();
  let seq = 0;
  const box = { now: () => clock.t, setTimer: (fn, ms) => { timers.set(++seq, { at: clock.t + ms, ms, fn }); return seq; }, clearTimer: id => timers.delete(id) };
  const macArms = [];
  const mac = { setTimer: (fn, ms) => { macArms.push(ms); const x = setTimeout(fn, ms); x.unref(); return x; } };
  const get = seams.get.bind(seams);
  seams.get = root => {
    const own = get(root);
    if (own || !root) return own;
    try {
      const role = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).role;
      return role === "box" ? box : role === "local" ? mac : undefined;
    } catch { return undefined; }
  };
  t.after(() => { seams.get = get; });
  /** Move the box's clock to a moment and run the timers due by then. */
  const advanceTo = at => {
    clock.t = at;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= clock.t).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  return { clock, timers, macArms, advanceTo };
}

/** The Mac's proxied box stream, collected as parsed events. */
function stream(t, root) {
  const seen = [];
  const req = http.get({ socketPath: paths(root).socket, path: "/v1/link/events?type=planner.*&since=latest" }, res => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", c => {
      buf += c;
      const blocks = buf.split("\n\n");
      buf = blocks.pop() || "";
      for (const b of blocks) { const d = b.split("\n").find(l => l.startsWith("data: ")); if (d) seen.push(JSON.parse(d.slice(6))); }
    });
  });
  req.on("error", () => {});
  t.after(() => req.destroy());
  return seen;
}

test("planner over the link: the Mac adds on the box, hears the box ring, and its done acks there", async t => {
  const c = fakeClocks(t);
  const s = await pair(t);
  const macPlanner = () => /** @type {any} */ (s.mac.registry.modules.get("planner")).handle;
  const boxPlanner = () => /** @type {any} */ (s.box.registry.modules.get("planner")).handle;
  // Paired: the Mac's scheduler goes idle and leaves the ringing to the box.
  await until(() => macPlanner().scheduler.idle === true, 5000);
  assert.equal(boxPlanner().scheduler.idle, false);

  // (1) An alarm added on the Mac lands in the box's store, not the Mac's.
  const at = T0 + 30 * MIN;
  const added = await s.macCall("planner.add", { kind: "alarm", at, title: "Call Northwind Bakery" });
  assert.ok(!added.error, JSON.stringify(added.error));
  assert.equal(added.data.kind, "alarm");
  assert.equal(added.data.at, at);
  const id = added.data.id;
  const onBox = await s.boxCall("planner.get", { item: id });
  assert.ok(!onBox.error, JSON.stringify(onBox.error));
  assert.equal(onBox.data.item.title, "Call Northwind Bakery");
  assert.equal(onBox.data.item.next_fire, at);
  const macOwner = s.mac.kernel.chains.fromFacts({ kind: "device", device_key_id: "d", person: s.mac.kernel.id.owner, path: "direct" });
  assert.equal((await s.mac.kernel.gateway.records.query(macOwner, "reminder", { page: { limit: 5 } })).rows.length, 0, "nothing is stored on the Mac");
  assert.equal(macPlanner().scheduler.timer, null, "the Mac's scheduler holds no timer");
  assert.deepEqual(c.macArms, [], "the Mac's scheduler never armed");
  // The box's one timer waits for the alarm.
  assert.deepEqual([...c.timers.values()].map(x => x.at), [at]);

  // (2) The box rings; the Mac's stream carries it, tagged with its source.
  const seen = stream(t, s.macRoot);
  await wait(200);
  c.advanceTo(at);
  const fired = await until(() => seen.find(e => e.type === "planner.fired" && e.payload.item === id), 5000);
  assert.equal(fired.source, "box");
  assert.equal(fired.payload.kind, "alarm");
  assert.equal(fired.payload.title, "Call Northwind Bakery");
  assert.equal(fired.payload.due, at);
  const firing = fired.payload.firing;
  assert.ok(firing, "the event names its firing");
  assert.equal((await s.boxCall("planner.get", { firing })).data.firing.state, "ringing");

  // (3) Done on the Mac acknowledges the box's firing, and the ack comes back on the stream.
  const done = await s.macCall("planner.done", { firing });
  assert.ok(!done.error, JSON.stringify(done.error));
  assert.equal(done.data.firing.state, "acked");
  const acked = await until(() => seen.find(e => e.type === "planner.acked" && e.payload.firing === firing), 5000);
  assert.equal(acked.source, "box");
  assert.equal(acked.payload.action, "done");
  const after = (await s.boxCall("planner.get", { firing })).data;
  assert.equal(after.firing.state, "acked");
  assert.equal(after.item.state, "done", "a one-off alarm ends when it is done");
  assert.equal((await s.mac.kernel.gateway.records.query(macOwner, "planner-ring", { page: { limit: 5 } })).rows.length, 0, "no firing on the Mac");
});
