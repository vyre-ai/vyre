// @ts-check
// A watcher's schedule follows the Space's time zone. When that zone is not the one the schedule ran in before, the watchers are re-aimed once and the person is told which ones fire at another time.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Runtime, MIGRATIONS, LATE_MIGRATIONS } from "./runtime.js";
import { tempHome } from "../../test/helpers.js";

function rig(t, zoneOf) {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "watchers", [...MIGRATIONS, ...LATE_MIGRATIONS]);
  const events = /** @type {any[]} */ ([]), notices = /** @type {string[]} */ ([]);
  const now = Date.UTC(2026, 2, 2, 10, 7);
  const rt = new Runtime({ db, dir: path.join(root, "w"), now: () => now, log: () => {}, zone: zoneOf, emit: (type, payload) => events.push({ type, ...payload }), notice: text => { notices.push(text); }, call: async () => ({}), fetch: async () => "", teach: async () => true });
  const add = (name, schedule) => db.prepare("INSERT INTO watchers_watchers (name, schedule, enabled, paused, next_at) VALUES (?, ?, 1, 0, ?)").run(name, schedule, now + 1e9);
  return { rt, db, events, notices, add, now };
}

test("a watcher whose schedule moved with the zone is re-aimed once and the person is told", t => {
  let zone = "UTC";
  const r = rig(t, () => zone);
  r.add("morning", "0 9 * * *");
  r.add("often", "*/15 * * * *");
  r.rt.tick();                      // first sight of the zone: stored, nothing to say
  assert.equal(r.notices.length, 0);
  zone = "America/New_York";
  r.rt.tick();
  assert.equal(r.events.filter(e => e.type === "watcher.schedule-moved").length, 1);
  const ev = r.events.find(e => e.type === "watcher.schedule-moved");
  assert.deepEqual(ev.watchers.map((/** @type {any} */ w) => w.name), ["morning"], "an every-15-minutes schedule fires when it did");
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /America\/New_York.*morning \(every day at 09:00 \(America\/New_York\)\)/);
  const next = r.db.prepare("SELECT next_at FROM watchers_watchers WHERE name = 'morning'").get().next_at;
  assert.equal(new Date(next).toISOString(), "2026-03-02T14:00:00.000Z", "09:00 in New York, not 09:00 UTC");
  r.rt.tick();
  assert.equal(r.notices.length, 1, "told once");
});
