// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Store, MIGRATIONS, fold, minuteKey, hourKey } from "./store.js";
import { SCRATCH } from "../../test/scratch.mjs";

function db(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vitals-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = open(path.join(dir, "vyre.db"));
  migrate(d, "vitals", MIGRATIONS);
  return d;
}

test("minuteKey and hourKey: UTC, truncated to the minute and the hour", () => {
  const at = Date.UTC(2026, 8, 28, 14, 37, 52);
  assert.equal(minuteKey(at), "2026-09-28T14:37");
  assert.equal(hourKey(at), "2026-09-28T14");
});

test("fold: mean and max, nulls dropped, all-null stays null (never a false 0)", () => {
  assert.deepEqual(fold([10, 20, 30]), { mean: 20, max: 30 });
  assert.deepEqual(fold([null, null]), { mean: null, max: null });
  assert.deepEqual(fold([5, null, 15]), { mean: 10, max: 15 });
  assert.deepEqual(fold([]), { mean: null, max: null });
});

test("Store.record and latest: one row per minute, a later record in the same minute replaces it", t => {
  const s = new Store(db(t), () => 0);
  const row = { minute: "2026-09-28T14:00", device: "server", cpu: 40, cpuMax: 55, ram: 30, ramMax: 30, gpu: null, disk: 20, netRx: 1000, netTx: 500, battery: null };
  s.record(row);
  assert.deepEqual({ ...s.latest("server") }, { minute: "2026-09-28T14:00", device: "server", scope: "",
    cpu: 40, cpuMax: 55, ram: 30, ramMax: 30, gpu: null, disk: 20, netRx: 1000, netTx: 500, battery: null });
  s.record({ ...row, cpu: 60, cpuMax: 70 });
  assert.equal(s.latest("server").cpu, 60, "the same minute is replaced, not a second row");
  assert.equal(s.latest("nope"), null);
});

test("Store: scope keeps an agent's computer and the server's own number apart", t => {
  const s = new Store(db(t), () => 0);
  s.record({ minute: "2026-09-28T14:00", device: "server", scope: "", cpu: 10, cpuMax: 10, ram: null, ramMax: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null });
  s.record({ minute: "2026-09-28T14:00", device: "server", scope: "agent:kit", cpu: 80, cpuMax: 80, ram: null, ramMax: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null });
  assert.equal(s.latest("server", "").cpu, 10);
  assert.equal(s.latest("server", "agent:kit").cpu, 80);
});

test("Store.history: oldest first, only this device/scope, only minutes since the given time", t => {
  const s = new Store(db(t), () => 0);
  for (const [m, cpu] of [["2026-09-28T13:58", 1], ["2026-09-28T13:59", 2], ["2026-09-28T14:00", 3]]) {
    s.record({ minute: m, device: "server", cpu, cpuMax: cpu, ram: null, ramMax: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null });
  }
  s.record({ minute: "2026-09-28T14:00", device: "mac1", cpu: 99, cpuMax: 99, ram: null, ramMax: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null });
  const h = s.history("server", "", Date.parse("2026-09-28T13:59:00Z"));
  assert.deepEqual(h.map(r => [r.minute, r.cpu]), [["2026-09-28T13:59", 2], ["2026-09-28T14:00", 3]]);
});

test("Store.rollupHour: averages cpu/ram, peaks cpuMax/ramMax, across every minute that hour saw, per device/scope", t => {
  const s = new Store(db(t), () => 0);
  for (const [m, cpu, cpuMax] of [["2026-09-28T14:00", 10, 20], ["2026-09-28T14:30", 30, 50], ["2026-09-28T14:59", 20, 20]]) {
    s.record({ minute: m, device: "server", cpu, cpuMax, ram: 10, ramMax: 10, gpu: null, disk: 5, netRx: 100, netTx: 50, battery: null });
  }
  // A different hour and a different device must not bleed in.
  s.record({ minute: "2026-09-28T15:00", device: "server", cpu: 999, cpuMax: 999, ram: null, ramMax: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null });
  s.record({ minute: "2026-09-28T14:00", device: "mac1", cpu: 5, cpuMax: 5, ram: null, ramMax: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null });
  s.rollupHour("2026-09-28T14");
  const rows = s.db.prepare("SELECT * FROM vitals_hour ORDER BY device").all();
  assert.equal(rows.length, 2, "one row per device/scope pair that hour, never per minute");
  const server = rows.find(r => r.device === "server");
  assert.equal(server.cpu, 20, "mean of 10, 30, 20");
  assert.equal(server.cpuMax, 50, "peak, not mean, for the *Max columns");
  assert.equal(server.ram, 10);
  assert.equal(server.disk, 5);
  assert.equal(rows.find(r => r.device === "mac1").cpu, 5);
});

test("Store.prune: drops minute rows past 24h and hour rows past 30 days, keeps the rest", t => {
  const DAY = 24 * 3600_000;
  let clock = Date.UTC(2026, 8, 28, 12, 0, 0);
  const s = new Store(db(t), () => clock);
  s.record({ minute: minuteKeyAt(clock - 25 * 3600_000), device: "server", cpu: 1, cpuMax: 1, ram: null, ramMax: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null });
  s.record({ minute: minuteKeyAt(clock - 1 * 3600_000), device: "server", cpu: 2, cpuMax: 2, ram: null, ramMax: null, gpu: null, disk: null, netRx: null, netTx: null, battery: null });
  s.db.prepare("INSERT INTO vitals_hour (hour, device, scope, cpu, cpuMax, ram, ramMax, gpu, disk, netRx, netTx, battery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(hourKeyAt(clock - 31 * DAY), "server", "", 1, 1, null, null, null, null, null, null, null);
  s.db.prepare("INSERT INTO vitals_hour (hour, device, scope, cpu, cpuMax, ram, ramMax, gpu, disk, netRx, netTx, battery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(hourKeyAt(clock - 1 * DAY), "server", "", 2, 2, null, null, null, null, null, null, null);
  s.prune();
  const minutes = s.db.prepare("SELECT cpu FROM vitals_minute ORDER BY minute").all();
  assert.deepEqual(minutes.map(r => r.cpu), [2], "the 25h-old minute is gone, the 1h-old one stays");
  const hours = s.db.prepare("SELECT cpu FROM vitals_hour ORDER BY hour").all();
  assert.deepEqual(hours.map(r => r.cpu), [2], "the 31-day-old hour is gone, the 1-day-old one stays");
});

test("Store.breaches: counts hourly peaks at or over the threshold, in the last N days only", t => {
  let clock = Date.UTC(2026, 8, 28, 12, 0, 0);
  const s = new Store(db(t), () => clock);
  const DAY = 24 * 3600_000;
  const put = (ago, ramMax) => s.db.prepare("INSERT INTO vitals_hour (hour, device, scope, cpu, cpuMax, ram, ramMax, gpu, disk, netRx, netTx, battery) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(hourKeyAt(clock - ago), "server", "", null, null, null, ramMax, null, null, null, null, null);
  put(1 * DAY, 95);
  put(2 * DAY, 60);
  put(3 * DAY, 92);
  put(10 * DAY, 99); // outside a 7-day window
  assert.equal(s.breaches("server", "", "ram", 90, 7), 2);
  assert.equal(s.breaches("server", "", "ram", 90, 14), 3);
  assert.equal(s.breaches("server", "", "ram", 90, 0), 0);
});

const minuteKeyAt = at => new Date(at).toISOString().slice(0, 16);
const hourKeyAt = at => new Date(at).toISOString().slice(0, 13);
