// @ts-check
// The computers module in a real vyred, in process: the fake driver, and stand-ins for the
// agents and threads modules written with writeModule (the real ones live on the switchboard's
// branch and are only ever reached through ctx.call). The clock is the pool's own now(), moved by
// the test; the real sweep timer is off (sweepMs 0).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { FakeDriver } from "./driver/fake.js";

const AGENTS_SRC = `
const AGENTS = [
  { name: "juno", kind: "assistant", computer: false },
  { name: "kit", kind: "agent", computer: true },
  { name: "pax", kind: "agent", computer: true },
];
export default { async start(ctx) {
  ctx.tool("agents.list", { input: { type: "object" }, run: async () => AGENTS });
  ctx.tool("agents.threads", { input: { type: "object", required: ["agent"], properties: { agent: { type: "string" } } },
    run: async ({ agent }) => (agent === "kit" ? [{ id: "th-kit" }] : []) });
  return { async stop() {} };
} };`;

// The switchboard's lease, as far as computers can see it: lease, release, and lease.changed
// with the thread in the event's thread column.
const THREADS_SRC = `
export default { async start(ctx) {
  const held = new Map();
  const obj = { type: "object", required: ["thread"], properties: { thread: { type: "string" }, surface: { type: "string" } } };
  ctx.tool("threads.lease", { input: obj, run: async ({ thread, surface }, { caller }) => {
    const s = surface || caller, previous = held.get(thread) || null;
    held.set(thread, s);
    if (previous !== s) ctx.events.emit("lease.changed", { holder: s, previous }, { thread });
    return { thread, holder: s, previous };
  } });
  ctx.tool("threads.release", { input: obj, run: async ({ thread, surface }, { caller }) => {
    const s = surface || caller;
    if (held.get(thread) !== s) return { thread, released: false, holder: held.get(thread) || null };
    held.delete(thread);
    ctx.events.emit("lease.changed", { holder: null, previous: s }, { thread });
    return { thread, released: true, holder: null };
  } });
  return { async stop() {} };
} };`;

/**
 * A vyred with the computers module on the fake driver.
 * @param {any} t
 * @param {{ computers?: any, agents?: boolean, threads?: boolean, root?: string }} [o]
 */
async function boot(t, o = {}) {
  const root = o.root || tempHome(t);
  if (!o.root) {
    t.after(() => FakeDriver.forget(root));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box",
      computers: o.computers === undefined ? { driver: "fake", sweepMs: 0, waitMs: 100 } : o.computers }));
    const mods = path.join(root, "modules");
    if (o.agents !== false) writeModule(mods, "agents", { does: { tools: ["agents.list", "agents.threads"] } }, AGENTS_SRC);
    if (o.threads !== false) writeModule(mods, "threads", { does: { tools: ["threads.lease", "threads.release"] }, watches: { emits: ["lease.changed"] } }, THREADS_SRC);
  }
  /** @type {string[]} */
  const logs = [];
  const d = await start({ root, log: (m, x) => logs.push(m + (x ? " " + JSON.stringify(x) : "")) });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await d.stop(); } };
  t.after(stop);
  const mod = d.registry.modules.get("computers");
  assert.equal(mod?.state, "running", `computers did not start: ${mod?.error}`);
  const h = mod.handle;
  const clock = { t: 1_000 };
  h.pool.now = () => clock.t;
  /** Every result a test saw, for the secret scan. */
  const results = [];
  const as = (caller) => async (tool, input = {}) => { const r = await call(tool, input, { root, caller }); results.push(r); return r; };
  /** A module's call: the only way to reach the internal tools. */
  const mod_ = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "module:hands-chrome"); results.push(r); return r; };
  return { root, d, h, clock, logs, results, stop, cli: as("cli"), kit: as("mcp:agent:kit"), juno: as("mcp:agent:juno"), module: mod_,
    events: () => d.events.since(0, { limit: 1000 }).filter(e => e.type.startsWith("computer.")) };
}

test("computers: the manifest loads on the box with its tools and the glass stream declared", async t => {
  const s = await boot(t);
  const tools = s.d.registry.listTools().map(x => x.name).filter(n => n.startsWith("computers."));
  assert.deepEqual(tools.sort(), ["computers.checkout", "computers.get", "computers.giveback", "computers.list", "computers.pause",
    "computers.release", "computers.resume", "computers.stop", "computers.takeover", "computers.watch"]);
  assert.equal((await s.cli("computers.endpoint", { agent: "kit" })).error.code, "no_such_tool", "an internal tool was reachable from the socket");
  // Glass is another file; whether or not it is there yet, the module runs and says which.
  const glass = s.d.registry.upgrades.has("computers/glass");
  assert.ok(glass || s.logs.some(l => /glass not available/.test(l)));
});

test("computers: without a driver, list says none and a checkout says why", async t => {
  const s = await boot(t, { computers: {} });
  const l = await s.cli("computers.list");
  assert.equal(l.data.driver, "none");
  assert.deepEqual(l.data.computers.map(c => [c.agent, c.state]), [["kit", "none"], ["pax", "none"]]);
  assert.match((await s.cli("computers.checkout", { agent: "kit" })).error.message, /no computer driver is configured/);
  assert.ok(s.logs.some(l => /no computer driver configured/.test(l)));
});

test("computers: without the agents module, a checkout is refused with a readable reason", async t => {
  const s = await boot(t, { agents: false, threads: false });
  assert.match((await s.cli("computers.checkout", { agent: "kit" })).error.message, /agents module is not running/);
});

test("computers: an agent's hands get their own computer; only the assistant may name another's", async t => {
  const s = await boot(t);
  const own = await s.kit("computers.checkout", {});
  assert.deepEqual(own.data, { agent: "kit", screen: 1, thread: null });
  assert.match((await s.kit("computers.checkout", { agent: "pax" })).error.message, /kit can only use its own computer, not pax's/);
  assert.match((await s.kit("computers.pause", { agent: "pax" })).error.message, /own computer/);
  assert.equal((await s.juno("computers.get", { agent: "kit" })).data.screen, 1);
  assert.match((await s.cli("computers.get", {})).error.message, /agent is required/);
  assert.match((await s.juno("computers.checkout", {})).error.message, /juno has no computer/);
  const mine = await s.kit("computers.list");
  assert.deepEqual(mine.data.computers.map(c => c.agent), ["kit"]);
  const all = await s.juno("computers.list");
  assert.deepEqual(all.data.computers.map(c => c.agent), ["kit", "pax"]);
  assert.match((await s.module("computers.may-act", { tool: "chrome.click" })).error.message, /agent is required/);
});

test("computers: endpoint checks out and thaws; may-act touches", async t => {
  const s = await boot(t);
  const e = await s.module("computers.endpoint", { agent: "kit", thread: "th-kit" });
  assert.equal(e.data.cdp, "http://fake-kit:9223");
  assert.equal(e.data.helper.url, "http://fake-kit:7000");
  assert.equal(typeof e.data.helper.token, "string");
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.thread, "th-kit");
  s.clock.t += 50_000;
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit", tool: "chrome.click" })).data, { ok: true });
  s.clock.t += 50_000; await s.h.sweep();
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.screen, 1, "may-act did not touch the checkout");
  s.clock.t += 10_000; await s.h.sweep();
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "running");
  s.clock.t += 15_000; await s.h.sweep();
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "frozen");
  await s.module("computers.endpoint", { agent: "kit" });
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "running");
  assert.deepEqual(s.events().map(e => e.type), ["computer.created", "computer.checked-out", "computer.released", "computer.frozen", "computer.thawed", "computer.checked-out"]);
});

test("computers: pause refuses the hands, resume lets them act", async t => {
  const s = await boot(t);
  assert.deepEqual((await s.cli("computers.pause", { agent: "kit" })).data, { paused: true });
  const no = await s.module("computers.may-act", { agent: "kit", tool: "chrome.type" });
  assert.equal(no.data.ok, false);
  assert.match(no.data.why, /kit is paused/);
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.paused, true);
  await s.cli("computers.resume", { agent: "kit" });
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit", tool: "chrome.type" })).data, { ok: true });
});

test("computers: take-over through the lease, chatting that does not pause, and the lease ending it", async t => {
  const s = await boot(t);
  // The user chats with kit from the Deck: the lease moves, kit keeps working.
  await s.d.registry.call("threads.lease", { thread: "th-kit", surface: "deck:laptop" }, "local");
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit", tool: "chrome.click" })).data, { ok: true });
  // Now they take over from Glass.
  const r = await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  assert.deepEqual(r.data, { agent: "kit", surface: "glass:laptop", thread: "th-kit", previous: "deck:laptop" });
  const no = (await s.module("computers.may-act", { agent: "kit", tool: "chrome.click" })).data;
  assert.equal(no.ok, false);
  assert.equal(no.holder, "glass:laptop");
  assert.equal(s.h.keyboard.canType("kit", "glass:laptop"), true);
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.takeover, "glass:laptop");
  // They pick up the phone: the take-over moves with the lease.
  await s.d.registry.call("threads.lease", { thread: "th-kit", surface: "phone:pocket" }, "local");
  assert.equal(s.h.keyboard.canType("kit", "phone:pocket"), true);
  assert.equal((await s.module("computers.may-act", { agent: "kit" })).data.holder, "phone:pocket");
  // The phone gives back.
  assert.deepEqual((await s.cli("computers.giveback", { agent: "kit", surface: "phone:pocket" })).data, { agent: "kit", handed_back: true });
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit" })).data, { ok: true });
  // Taken over again, and the lease released from elsewhere ends it.
  await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  await s.d.registry.call("threads.release", { thread: "th-kit", surface: "glass:laptop" }, "local");
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit" })).data, { ok: true });
  // And once more, left to expire.
  await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  s.clock.t += 90_000; await s.h.sweep();
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit" })).data, { ok: true });
  const back = s.events().filter(e => e.type === "computer.handed-back").map(e => e.payload.why);
  assert.deepEqual(back, ["gave back", "lease released", "lease expired"]);
  const over = s.events().filter(e => e.type === "computer.taken-over");
  assert.deepEqual(over.map(e => e.payload.surface), ["glass:laptop", "phone:pocket", "glass:laptop", "glass:laptop"]);
  assert.ok(over.every(e => e.thread === "th-kit"), "take-over events should carry the thread");
  assert.match((await s.cli("computers.takeover", { agent: "kit", surface: "cli" })).error.message, /person's screen/);
});

test("computers: watch hands out a one-use ticket that expires", async t => {
  const s = await boot(t);
  const w = (await s.cli("computers.watch", { agent: "kit", surface: "glass:laptop" })).data;
  assert.equal(w.width, 1440);
  assert.equal(w.height, 900);
  assert.equal(w.path, `/v1/streams/computers/glass?ticket=${encodeURIComponent(w.ticket)}`);
  assert.deepEqual(s.h.pool.redeem(w.ticket), { agent: "kit", surface: "glass:laptop" });
  assert.equal(s.h.pool.redeem(w.ticket), null);
  const late = (await s.cli("computers.watch", { agent: "kit", surface: "glass:laptop" })).data;
  s.clock.t += 30_000;
  assert.equal(s.h.pool.redeem(late.ticket), null);
  assert.match((await s.cli("computers.watch", { agent: "juno", surface: "glass:laptop" })).error.message, /juno has no computer/);
});

test("computers: eviction and a full pool through the tools", async t => {
  const s = await boot(t, { computers: { driver: "fake", sweepMs: 0, waitMs: 60, screens: 1 } });
  await s.cli("computers.checkout", { agent: "kit" });
  const pax = await s.cli("computers.checkout", { agent: "pax" });
  assert.equal(pax.data.screen, 1);
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.screen, null);
  await s.h.pool.viewer("pax", 1);
  assert.match((await s.cli("computers.checkout", { agent: "kit" })).error.message, /every screen is in use \(pax \(watched by 1\)\)/);
});

test("computers: after a restart the table and the driver agree again", async t => {
  const s = await boot(t);
  await s.cli("computers.checkout", { agent: "kit" });
  await s.cli("computers.checkout", { agent: "pax" });
  const rows = Object.fromEntries(s.h.pool.rows().map(r => [r.agent, r]));
  await s.stop();
  const driver = FakeDriver.for(s.root);
  await driver.remove(rows.pax.container);
  const orphan = (await driver.create({ agent: "juno", image: "i", env: {}, labels: {}, volume: "v" })).id;
  const again = await boot(t, { root: s.root });
  const l = (await again.cli("computers.list")).data.computers;
  assert.deepEqual(l.map(c => [c.agent, c.state, c.screen]), [["kit", "running", null], ["pax", "none", null]]);
  assert.equal(driver.containers.has(orphan), false);
  const creates = driver.calls.filter(c => c.op === "create").length;
  await again.cli("computers.checkout", { agent: "kit" });
  assert.equal(driver.calls.filter(c => c.op === "create").length, creates, "kit's surviving computer was made again");
  assert.equal(again.h.pool.row("kit").vnc_password, rows.kit.vnc_password, "the surviving container lost its password");
});

test("computers: stop keeps the home and emits stopped; release gives the screen back", async t => {
  const s = await boot(t);
  await s.cli("computers.checkout", { agent: "kit" });
  assert.deepEqual((await s.cli("computers.release", { agent: "kit" })).data, { released: true });
  assert.deepEqual((await s.cli("computers.release", { agent: "kit" })).data, { released: false });
  await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  assert.deepEqual((await s.cli("computers.stop", { agent: "kit" })).data, { stopped: true });
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "stopped");
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.takeover, null, "a stopped computer kept its take-over");
  assert.ok(s.events().some(e => e.type === "computer.stopped"));
});

test("computers: no password or token ever reaches a tool result, an event or a log line", async t => {
  const s = await boot(t);
  /** @type {Set<string>} */
  const secrets = new Set();
  const collect = () => { for (const r of s.h.pool.rows()) { secrets.add(String(r.vnc_password)); secrets.add(String(r.helper_token)); } };
  collect();
  await s.cli("computers.list");
  await s.kit("computers.checkout", { thread: "th-kit", why: "open a page" }); collect();
  await s.cli("computers.get", { agent: "kit" });
  await s.cli("computers.watch", { agent: "kit", surface: "glass:laptop" });
  await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  await s.module("computers.may-act", { agent: "kit", tool: "chrome.click" });
  await s.cli("computers.list");
  await s.cli("computers.giveback", { agent: "kit", surface: "glass:laptop" });
  await s.cli("computers.pause", { agent: "kit" });
  await s.cli("computers.resume", { agent: "kit" });
  await s.cli("computers.release", { agent: "kit" });
  s.clock.t += 20_000; await s.h.sweep();
  await s.cli("computers.checkout", { agent: "kit" });
  await s.cli("computers.checkout", { agent: "pax" }); collect();
  await s.cli("computers.stop", { agent: "pax" });
  await FakeDriver.for(s.root).remove(String(s.h.pool.row("kit").container));
  await s.cli("computers.release", { agent: "kit" });
  await s.cli("computers.checkout", { agent: "kit" }); collect();
  await s.cli("computers.list");
  // The one sanctioned exception: endpoint is internal, and the hands need the token.
  const ep = await s.d.registry.call("computers.endpoint", { agent: "kit" }, "module:hands-chrome");
  assert.ok(secrets.has(ep.data.helper.token), "the scan would not see a token even if one leaked");
  assert.ok(secrets.size >= 6, "the scenario should have made several sets of secrets");
  const haystacks = [
    ...s.results.map(r => ["result", JSON.stringify(r)]),
    ...s.d.events.since(0, { limit: 5000 }).map(e => ["event " + e.type, JSON.stringify(e)]),
    ...s.logs.map(l => ["log", l]),
  ];
  assert.ok(haystacks.length > 30);
  for (const secret of secrets) {
    assert.ok(secret.length >= 8);
    for (const [where, text] of haystacks) assert.ok(!text.includes(secret), `a computer secret appeared in a ${where}`);
  }
});
