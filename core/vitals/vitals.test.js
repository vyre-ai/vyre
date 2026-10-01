// @ts-check
// vitals in a real vyred: the manifest, the person-only/agent-summary split, one forced tick
// (mod.handle.tick(), never a 60s wait), the events it emits, and the rollup/prune math end to
// end through the real store. seams stand in for this device's own OS reads and for computers'
// per-agent breakdown, so nothing here touches a real /proc, cgroup or Docker.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { seams } from "./index.js";

/** @param {any} t @param {{ role?: string, own?: () => any, computers?: () => any }} [o] */
async function boot(t, o = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: o.role || "box", modules: { disable: ["agents", "computers"] } }));
  const clock = { at: Date.parse("2026-09-28T14:00:00Z") };
  seams.set(root, { now: () => clock.at, own: o.own, computers: o.computers });
  t.after(() => seams.delete(root));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const mod = d.registry.modules.get("vitals");
  assert.equal(mod?.state, "running", `vitals did not start: ${mod?.error}`);
  return { root, d, clock, h: mod.handle, cli: (tool, input = {}) => call(tool, input, { root, caller: "cli" }),
    agent: (name) => (tool, input = {}) => d.registry.call(tool, input, `mcp:agent:${name}`) };
}

const flat = () => ({ cpu: 10, ram: 20, gpu: null, disk: 30, netRx: 100, netTx: 50, battery: null });

test("vitals: the manifest loads with its five tools and both events, on both roles", async t => {
  const s = await boot(t);
  const tools = s.d.registry.listTools().map(x => x.name).filter(n => n.startsWith("vitals."));
  assert.deepEqual(tools.sort(), ["vitals.advice", "vitals.explain", "vitals.status", "vitals.summary", "vitals.watch"]);
  const events = s.d.registry.modules.get("vitals").manifest.watches.emits;
  assert.deepEqual(events.sort(), ["vitals.sample", "vitals.trouble"]);
});

test("vitals: status and watch refuse an agent outright; summary is the one tool an agent may call", async t => {
  const s = await boot(t, { own: flat });
  await s.h.tick();
  // The manifest's reach is person, so the registry turns an agent away before the tool's own check (which stays as the second lock).
  assert.match((await s.agent("kit")("vitals.status", {})).error.message, /vitals\.status is not available to mcp callers/);
  assert.match((await s.agent("kit")("vitals.watch", { action: "open" })).error.message, /vitals\.watch is not available to mcp callers/);
  const sum = await s.agent("kit")("vitals.summary", {});
  assert.ok(!sum.error, sum.error && sum.error.message);
  assert.deepEqual(Object.keys(sum.data).sort(), ["battery", "cpu", "device", "disk", "gpu", "netRx", "netTx", "ram", "scope"]);
});

test("vitals: summary structurally has no field for a process name or a window title", async t => {
  const s = await boot(t, { own: flat });
  await s.h.tick();
  const r = await s.cli("vitals.summary", {});
  for (const k of Object.keys(r.data)) assert.doesNotMatch(k, /process|window|title|pid/i);
});

test("vitals: one tick samples, persists once, and status sees the same numbers", async t => {
  const s = await boot(t, { own: flat });
  await s.h.tick();
  const r = await s.cli("vitals.status", {});
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.data.device, "server");
  assert.equal(r.data.latest.cpu, 10);
  assert.equal(r.data.latest.disk, 30);
  assert.equal(r.data.history.length, 1);
});

test("vitals: an agent's computer gets its own scope, kept apart from the server's own number", async t => {
  const s = await boot(t, { own: flat, computers: async () => [{ scope: "agent:kit", cpu: 77, ram: 44, netRx: 10, netTx: 5 }] });
  await s.h.tick();
  const status = await s.cli("vitals.status", {});
  assert.equal(status.data.latest.cpu, 10, "the server's own row is untouched by kit's");
  assert.deepEqual(status.data.computers.map(c => c.scope), ["agent:kit"]);
  assert.equal(status.data.computers[0].latest.cpu, 77);
  const kitSummary = await s.agent("kit")("vitals.summary", {});
  assert.equal(kitSummary.data.scope, "agent:kit");
  assert.equal(kitSummary.data.cpu, 77);
  const junoSummary = await s.agent("juno")("vitals.summary", {});
  assert.equal(junoSummary.data.cpu, null, "an agent with no computer sample gets nulls, not a refusal");
});

test("vitals: watch opens and closes a subscription and hands back the in-memory buffer", async t => {
  const s = await boot(t, { own: flat });
  const open = await s.cli("vitals.watch", { action: "open" });
  assert.equal(open.data.watchers, 1);
  await s.h.tick();
  const still = await s.cli("vitals.watch", { action: "open" });
  assert.equal(still.data.watchers, 2);
  assert.equal(still.data.buffer.length, 1);
  assert.equal(still.data.buffer[0].cpu, 10);
  await s.cli("vitals.watch", { action: "close" });
  await s.cli("vitals.watch", { action: "close" });
  assert.equal((await s.cli("vitals.watch", { action: "close" })).data.watchers, 0, "never goes negative");
});

test("vitals: sample fires every tick; trouble fires once per sustained episode, not once per sample", async t => {
  const events = [];
  const s = await boot(t, { own: () => ({ ...flat(), cpu: 99 }) });
  const off = s.d.events.on("vitals.sample", e => events.push(e.payload));
  const offT = s.d.events.on("vitals.trouble", e => events.push({ trouble: true, ...e.payload }));
  for (let i = 0; i < 4; i++) { s.clock.at += 60_000; await s.h.tick(); }
  off(); offT();
  const samples = events.filter(e => !e.trouble);
  const trouble = events.filter(e => e.trouble);
  assert.equal(samples.length, 4);
  assert.equal(samples[0].cpu, 99);
  assert.equal(trouble.length, 1, "one event for the whole episode, not one per over-threshold sample");
  assert.equal(trouble[0].metric, "cpu");
  assert.equal(trouble[0].device, "server");
});

test("vitals: explain digests the last 15 minutes without the caller ever touching raw rows", async t => {
  const s = await boot(t, { own: flat });
  for (let i = 0; i < 3; i++) { s.clock.at += 60_000; await s.h.tick(); }
  const r = await s.cli("vitals.explain", {});
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.data.device, "server");
  assert.equal(r.data.top.metric, "disk", "disk (30) is the highest of cpu 10, ram 20, disk 30");
  assert.deepEqual(r.data.trend, { cpu: "flat", ram: "flat" });
  assert.deepEqual(r.data.trouble, []);
});

test("vitals: advice reads hourly rollups, never pushes anything, and needs at least a few breaches", async t => {
  const s = await boot(t, { own: () => ({ ...flat(), ram: 95 }) });
  // A week of hourly rollups, most breaching ram's 90% default.
  for (let d = 0; d < 5; d++) { s.clock.at += 24 * 3600_000; await s.h.tick(); s.h.store.rollupHour(new Date(s.clock.at).toISOString().slice(0, 13)); }
  const r = await s.cli("vitals.advice", {});
  assert.ok(!r.error, r.error && r.error.message);
  assert.match(r.data.advice.join(" "), /RAM hit 90% or more \d+ times this week/);
});
