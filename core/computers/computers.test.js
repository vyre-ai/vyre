// @ts-check
// The computers module in a real vyred, in process: the fake driver, and the real agents and
// switchboard (module name "threads") modules, both core now and no longer fakeable under their
// own names (core/modules/index.js: "the first found wins"). kit's thread is a real thread,
// launched through threads.launch with the fake `claude` at core/switchboard/testing/fake-claude.js
// standing in for the real binary, so threads.lease has an actual row to hold a lease on. The
// clock is the pool's own now(), moved by the test; the real sweep timer is off (sweepMs 0).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { HUMAN_ONLY, PERSON_ONLY } from "../presence/index.js";
import { FakeDriver } from "./driver/fake.js";

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE_CLAUDE, 0o755);

/**
 * A vyred with the computers module on the fake driver, plus real agents "juno" (the assistant),
 * "kit" and "pax" (both computer: true), with a real thread launched for kit.
 * @param {any} t
 * @param {{ computers?: any, agents?: boolean, root?: string, glass?: any, presence?: any }} [o]
 */
async function boot(t, o = {}) {
  const root = o.root || tempHome(t);
  if (!o.root) {
    t.after(() => FakeDriver.forget(root));
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box",
      computers: o.computers === undefined ? { driver: "fake", sweepMs: 0, waitMs: 100 } : o.computers,
      ...(o.glass ? { glass: o.glass } : {}),
      modules: { disable: o.agents === false ? ["agents"] : [] } }));
  }
  const prevEnv = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  process.env.VYRE_CLAUDE_BIN = FAKE_CLAUDE;
  delete process.env.FAKE_CLAUDE_LOG;
  t.after(() => { for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  /** @type {string[]} */
  const logs = [];
  const d = await start({ presence: o.presence || present, root, log: (m, x) => logs.push(m + (x ? " " + JSON.stringify(x) : "")) });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await d.stop(); } };
  t.after(stop);
  const mod = d.registry.modules.get("computers");
  assert.equal(mod?.state, "running", `computers did not start: ${mod?.error}`);
  const h = mod.handle;
  const clock = { t: 1_000 };
  h.pool.now = () => clock.t;
  let kitThread = o.root ? o.kitThread : null;
  if (o.agents !== false && !o.root) {
    const agentsMod = d.registry.modules.get("agents");
    assert.equal(agentsMod?.state, "running", `agents did not start: ${agentsMod?.error}`);
    for (const [name, kind] of [["juno", "assistant"], ["kit", "agent"], ["pax", "agent"]]) {
      const r = await d.registry.call("agents.create", { name, kind, projects: kind === "assistant" ? undefined : [], computer: kind === "agent" }, "local");
      if (r.error) throw new Error(`agents.create ${name}: ${r.error.message}`);
    }
    const work = fs.mkdtempSync(path.join(root, "kit-work-"));
    const launched = await d.registry.call("threads.launch", { agent: "kit", agent_kind: "agent", cwd: work }, "module:computers-test");
    if (launched.error) throw new Error(`threads.launch for kit: ${launched.error.message}`);
    kitThread = launched.data.id;
  }
  /** Every result a test saw, for the secret scan. */
  const results = [];
  const as = (caller) => async (tool, input = {}) => { const r = await call(tool, input, { root, caller }); results.push(r); return r; };
  // "mcp:agent:kit" claims over HTTP now need the switchboard's own vouch (x-vyre-agent-key
  // matching a live thread) — that HTTP-layer check is the switchboard's own, tested there.
  // What this file tests is computers.index.js's own caller-based resolve(), so an agent's
  // hands call straight through the registry, the way a module reaches another module's tools.
  const asAgent = (agent) => async (tool, input = {}) => { const r = await d.registry.call(tool, input, `mcp:agent:${agent}`); results.push(r); return r; };
  /** A module's call: the only way to reach the internal tools. */
  const mod_ = async (tool, input = {}) => { const r = await d.registry.call(tool, input, "module:hands-chrome"); results.push(r); return r; };
  return { root, d, h, clock, logs, results, stop, cli: as("cli"), kit: asAgent("kit"), juno: asAgent("juno"), module: mod_,
    kitThread, events: () => d.events.since(0, { limit: 1000 }).filter(e => e.type.startsWith("computer.")) };
}

test("computers: the manifest loads on the box with its tools and the glass stream declared", async t => {
  const s = await boot(t);
  const tools = s.d.registry.listTools().map(x => x.name).filter(n => n.startsWith("computers."));
  assert.deepEqual(tools.sort(), ["computers.checkout", "computers.egress.set", "computers.egress.status", "computers.get", "computers.giveback",
    "computers.handback.set", "computers.handback.status",
    "computers.limits", "computers.list",
    "computers.member.add", "computers.member.dispose", "computers.member.remove", "computers.member.rotate",
    "computers.pause", "computers.release", "computers.restart", "computers.resume", "computers.stop",
    "computers.tailnet.set", "computers.tailnet.status", "computers.takeover", "computers.watch"]);
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
  // The same self-only filter applies whatever transport vouches the agent's claim, not only
  // "mcp:agent:<name>": a caller shaped "cli agent:kit" (an agent vouched under the CLI) still
  // sees only its own computer, and still cannot name pax's (agentClaim, core/modules).
  const vouched = await s.d.registry.call("computers.list", {}, "cli agent:kit");
  assert.deepEqual(vouched.data.computers.map(c => c.agent), ["kit"]);
  assert.match((await s.d.registry.call("computers.checkout", { agent: "pax" }, "cli agent:kit")).error.message, /kit can only use its own computer, not pax's/);
  assert.match((await s.module("computers.may-act", { tool: "chrome.click" })).error.message, /agent is required/);
});

test("computers: endpoint checks out and thaws; may-act touches", async t => {
  const s = await boot(t);
  const e = await s.module("computers.endpoint", { agent: "kit", thread: s.kitThread });
  assert.equal(e.data.cdp, undefined, "Chrome's raw address is never handed out; only computerd's authenticated proxy is");
  assert.equal(e.data.helper.url, "http://fake-kit:7000");
  assert.equal(typeof e.data.helper.token, "string");
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.thread, s.kitThread);
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

test("computers: helper thaws without a screen; internal to both", async t => {
  const s = await boot(t);
  assert.equal((await s.cli("computers.helper", { agent: "kit" })).error.code, "no_such_tool", "computers.helper is internal");
  const h = (await s.module("computers.helper", { agent: "kit" })).data;
  assert.equal(h.url, "http://fake-kit:7000");
  assert.equal(typeof h.token, "string");
  assert.equal(h.cdp, undefined);
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "running");
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.screen, null, "helper took no screen");
  // Unlike a checkout, nothing holds it: it is eligible to freeze right away.
  s.clock.t += 15_000; await s.h.sweep();
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.state, "frozen");
});

test("computers: shield refuses every read and action, over pause and take-over both", async t => {
  const s = await boot(t);
  assert.equal((await s.cli("computers.shield", { agent: "kit", on: true })).error.code, "no_such_tool", "computers.shield is internal");
  const on = await s.module("computers.shield", { agent: "kit", on: true });
  assert.deepEqual(on.data, { agent: "kit", shielded: true, computerd: false });
  const no = (await s.module("computers.may-act", { agent: "kit", tool: "hands-desktop.read" })).data;
  assert.equal(no.ok, false);
  assert.match(no.why, /signing in/);
  assert.ok(s.events().some(e => e.type === "computer.shielded" && e.payload.agent === "kit"));
  const off = await s.module("computers.shield", { agent: "kit", on: false });
  assert.deepEqual(off.data, { agent: "kit", shielded: false, computerd: false });
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit", tool: "hands-desktop.read" })).data, { ok: true });
  assert.ok(s.events().some(e => e.type === "computer.unshielded" && e.payload.agent === "kit"));
});

test("computers: take-over through the lease, chatting that does not pause, and the lease ending it", async t => {
  const s = await boot(t);
  // The user chats with kit from the Deck: the lease moves, kit keeps working.
  await s.d.registry.call("threads.lease", { thread: s.kitThread, surface: "deck:laptop" }, "local");
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit", tool: "chrome.click" })).data, { ok: true });
  // Now they take over from Glass.
  const r = await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  assert.deepEqual(r.data, { agent: "kit", surface: "glass:laptop", thread: s.kitThread, previous: "deck:laptop" });
  const no = (await s.module("computers.may-act", { agent: "kit", tool: "chrome.click" })).data;
  assert.equal(no.ok, false);
  assert.equal(no.holder, "glass:laptop");
  assert.equal(s.h.keyboard.canType("kit", "glass:laptop"), true);
  assert.equal((await s.cli("computers.get", { agent: "kit" })).data.takeover, "glass:laptop");
  // They pick up the phone: the take-over moves with the lease.
  await s.d.registry.call("threads.lease", { thread: s.kitThread, surface: "phone:pocket" }, "local");
  assert.equal(s.h.keyboard.canType("kit", "phone:pocket"), true);
  assert.equal((await s.module("computers.may-act", { agent: "kit" })).data.holder, "phone:pocket");
  // The phone gives back.
  assert.deepEqual((await s.cli("computers.giveback", { agent: "kit", surface: "phone:pocket" })).data, { agent: "kit", handed_back: true });
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit" })).data, { ok: true });
  // Taken over again, and the lease released from elsewhere ends it.
  await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  await s.d.registry.call("threads.release", { thread: s.kitThread, surface: "glass:laptop" }, "local");
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit" })).data, { ok: true });
  // And once more, left to expire.
  await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  s.clock.t += 90_000; await s.h.sweep();
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit" })).data, { ok: true });
  const back = s.events().filter(e => e.type === "computer.handed-back").map(e => e.payload.why);
  assert.deepEqual(back, ["gave back", "lease released", "lease expired"]);
  const over = s.events().filter(e => e.type === "computer.taken-over");
  assert.deepEqual(over.map(e => e.payload.surface), ["glass:laptop", "phone:pocket", "glass:laptop", "glass:laptop"]);
  assert.ok(over.every(e => e.thread === s.kitThread), "take-over events should carry the thread");
  assert.match((await s.cli("computers.takeover", { agent: "kit", surface: "cli" })).error.message, /person's screen/);
});

test("computers: the owner takes and hands back the keyboard with no passkey; an agent still cannot", async t => {
  // The real rule for what needs a person (the floor's list, or the tool's own word), and a
  // verifier that finds nobody: setup runs first, then every proof fails.
  const gate = { on: false };
  const nobody = {
    required: (tool, def) => gate.on && (HUMAN_ONLY.has(tool) || Boolean(def && def.presence)),
    verify: async () => ({ ok: false, message: "nobody proved anything", methods: [] }),
    challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  };
  const s = await boot(t, { presence: nobody });
  gate.on = true;
  for (const tool of ["computers.takeover", "computers.giveback"]) {
    assert.ok(PERSON_ONLY.has(tool) && !HUMAN_ONLY.has(tool), `${tool} is person-only, not on the floor's list`);
    assert.ok(!s.d.registry.tools.get(tool).presence, `${tool} does not declare presence`);
  }
  assert.equal((await s.cli("gate.approve", { id: "g1" })).error?.code, "presence_required", "the floor still holds");
  assert.equal((await s.cli("computers.takeover", { agent: "kit", surface: "deck:laptop" })).data.surface, "deck:laptop");
  assert.equal(s.h.keyboard.canType("kit", "deck:laptop"), true);
  assert.match((await s.kit("computers.takeover", { surface: "glass:laptop" })).error.message, /is an agent, not a person's screen/);
  assert.match((await s.kit("computers.giveback", { surface: "deck:laptop" })).error.message, /is an agent, not a person's screen/);
  assert.deepEqual((await s.cli("computers.giveback", { agent: "kit", surface: "deck:laptop" })).data, { agent: "kit", handed_back: true });
});

test("computers: an agent cannot claim a surface, so it cannot end someone else's take-over", async t => {
  const s = await boot(t);
  await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  // kit's own hands, refused mid-take-over, try to give the keyboard back to itself.
  const gone = await s.kit("computers.giveback", { surface: "glass:laptop" });
  assert.match(gone.error.message, /is an agent, not a person's screen/);
  assert.equal(s.h.keyboard.canType("kit", "glass:laptop"), true, "the take-over is still held");
  // Same for taking over in the first place, and for watching as a surface it is not.
  assert.match((await s.kit("computers.takeover", { surface: "glass:laptop" })).error.message, /is an agent, not a person's screen/);
  assert.match((await s.kit("computers.watch", { surface: "glass:laptop" })).error.message, /is an agent, not a person's screen/);
  // The real surface can still give it back.
  assert.deepEqual((await s.cli("computers.giveback", { agent: "kit", surface: "glass:laptop" })).data, { agent: "kit", handed_back: true });
});

test("computers: watch hands out a one-use ticket that expires", async t => {
  const s = await boot(t);
  const w = (await s.cli("computers.watch", { agent: "kit", surface: "glass:laptop" })).data;
  assert.equal(w.width, 1440);
  assert.equal(w.height, 900);
  assert.equal(w.path, `/v1/streams/computers/glass?ticket=${encodeURIComponent(w.ticket)}`);
  assert.deepEqual(s.h.pool.redeem(w.ticket), { agent: "kit", surface: "glass:laptop", slow: false });
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
  await s.kit("computers.checkout", { thread: s.kitThread, why: "open a page" }); collect();
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

test("computers: stats is internal (vitals reads it, never the socket), and null before checkout", async t => {
  const s = await boot(t);
  assert.equal((await s.cli("computers.stats", { agent: "kit" })).error.code, "no_such_tool", "an internal tool was reachable from the socket");
  assert.deepEqual((await s.module("computers.stats", { agent: "kit" })).data, { cpu: null, ram: null, ramLimit: null, netRx: null, netTx: null });
  await s.kit("computers.checkout", {});
  const r = await s.module("computers.stats", { agent: "kit" });
  assert.deepEqual(r.data, { cpu: 12.5, ram: 30, ramLimit: 2 * 1024 * 1024 * 1024, netRx: 1000, netTx: 500 });
  await s.kit("computers.release", { agent: "kit" });
  await s.cli("computers.stop", { agent: "kit" });
  assert.deepEqual((await s.module("computers.stats", { agent: "pax" })).data, { cpu: null, ram: null, ramLimit: null, netRx: null, netTx: null }, "pax never had a computer made");
});

test("computers: limits are a person's or the assistant's to set, and restart applies them", async t => {
  const s = await boot(t);
  assert.match((await s.kit("computers.limits", { cpus: 8 })).error.message, /kit cannot change a computer's limits/);
  assert.deepEqual((await s.juno("computers.limits", { agent: "kit", cpus: 3 })).data.cpus, 3);
  const v = (await s.cli("computers.limits", { agent: "kit", memory_gb: 6 })).data;
  assert.deepEqual([v.cpus, v.memory_gb], [3, 6]);
  const r = await s.cli("computers.restart", { agent: "kit" });
  assert.equal(r.data.state, "running", r.error && r.error.message);
  const spec = [...s.h.driver.containers.values()].find(c => c.agent === "kit").spec;
  assert.deepEqual([spec.cpus, spec.memoryMb], [3, 6144]);
  assert.equal((await s.kit("computers.restart", {})).data.state, "running", "an agent may restart its own computer");
  assert.match((await s.kit("computers.restart", { agent: "pax" })).error.message, /kit can only use its own computer/);
});

// ---- egress ------------------------------------------------------------------------------

/** A port on loopback that nothing listens on: bound once, then closed. */
async function closedPort() {
  const net = await import("node:net");
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (srv.address()).port;
  await new Promise(r => srv.close(() => r(undefined)));
  return port;
}

/** Point the status tool's probe, and its gate status read, at local addresses for this test. */
function viaLocal(t, port, gatePort = port) {
  const prev = process.env.VYRE_EGRESS_PROXY, prevGate = process.env.VYRE_EGRESS_GATE_STATUS;
  process.env.VYRE_EGRESS_PROXY = `127.0.0.1:${port}`;
  process.env.VYRE_EGRESS_GATE_STATUS = `127.0.0.1:${gatePort}`;
  t.after(() => {
    if (prev === undefined) delete process.env.VYRE_EGRESS_PROXY; else process.env.VYRE_EGRESS_PROXY = prev;
    if (prevGate === undefined) delete process.env.VYRE_EGRESS_GATE_STATUS; else process.env.VYRE_EGRESS_GATE_STATUS = prevGate;
  });
}

test("computers: egress is off by default, and status says the sidecar does not answer on a closed port", async t => {
  viaLocal(t, await closedPort());
  const s = await boot(t);
  const r = await s.cli("computers.egress.status");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.data.enabled, false);
  assert.deepEqual(r.data.sites, []);
  assert.equal(r.data.sidecar.answers, false);
  assert.match(r.data.sidecar.why, /ECONNREFUSED|no answer/);
  assert.equal(r.data.gate.answers, false, "no gate, no verdict");
  assert.match(r.data.applies, /started after the change/);
  // Nothing about egress reached a new computer's env.
  await s.cli("computers.checkout", { agent: "kit" });
  const spec = [...FakeDriver.for(s.root).containers.values()][0].spec;
  assert.equal(spec.env.VYRE_PROXY_PAC, undefined);
});

test("computers: status reports a listening sidecar, and the configured sites", async t => {
  const net = await import("node:net");
  const srv = net.createServer(c => c.destroy());
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => srv.close());
  viaLocal(t, /** @type {any} */ (srv.address()).port);
  const s = await boot(t, { glass: { egress: { enabled: true, sites: ["bank.example.com", "*.harlow.example"] } } });
  const r = await s.cli("computers.egress.status");
  assert.deepEqual([r.data.enabled, r.data.sites, r.data.sidecar.answers], [true, ["bank.example.com", "*.harlow.example"], true]);
});

test("computers: status carries the gate's verdict, so a listed site that fails says why", async t => {
  const net = await import("node:net");
  const http = await import("node:http");
  const socks = net.createServer(c => c.destroy());
  await new Promise(r => socks.listen(0, "127.0.0.1", () => r(undefined)));
  const verdict = { allowed: false, reason: "the exit node is not offering itself, or its route is not approved (ExitNodeOption is false)" };
  const gate = http.createServer((req, res) => res.writeHead(req.url === "/status" ? 200 : 404, { connection: "close" }).end(JSON.stringify(verdict)));
  await new Promise(r => gate.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { socks.close(); gate.close(); });
  viaLocal(t, /** @type {any} */ (socks.address()).port, /** @type {any} */ (gate.address()).port);
  const s = await boot(t, { glass: { egress: { enabled: true, sites: ["portal.northwind.example"] } } });
  const r = await s.cli("computers.egress.status");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.data.gate, { answers: true, ...verdict });
  verdict.allowed = true;
  verdict.reason = "the exit node is online and offering itself";
  assert.equal((await s.cli("computers.egress.status")).data.gate.allowed, true);
});

test("computers: egress.set is the owner's, refused to an agent, saved to config and used by the next computer", async t => {
  viaLocal(t, await closedPort());
  const s = await boot(t);
  const refused = await s.kit("computers.egress.set", { enabled: true, sites: ["bank.example.com"] });
  assert.ok(refused.error, "an agent changed where its own browser goes out");
  const juno = await s.juno("computers.egress.set", { enabled: true, sites: ["bank.example.com"] });
  assert.ok(juno.error, "the assistant changed the egress setting");
  const bad = await s.cli("computers.egress.set", { enabled: true, sites: ['bank.example.com", "x'] });
  assert.match(bad.error.message, /is not a hostname/);
  const ok = await s.cli("computers.egress.set", { enabled: true, sites: ["Bank.Example.com"] });
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
  assert.deepEqual([ok.data.enabled, ok.data.sites], [true, ["bank.example.com"]]);
  assert.match(ok.data.applies, /started after the change/);
  const saved = JSON.parse(fs.readFileSync(path.join(s.root, "config.json"), "utf8"));
  assert.deepEqual(saved.glass.egress, { enabled: true, sites: ["bank.example.com"] });
  await s.cli("computers.checkout", { agent: "kit" });
  const spec = [...FakeDriver.for(s.root).containers.values()][0].spec;
  assert.match(spec.env.VYRE_PROXY_PAC, /^data:application\/x-ns-proxy-autoconfig;base64,/);
  assert.match(Buffer.from(spec.env.VYRE_PROXY_PAC.split(",")[1], "base64").toString(), /"bank\.example\.com"/);
});

// ---- tailnet: each computer as its own node ------------------------------------------------

test("computers: tailnet is off by default; status says so, and whether the key is in the vault, never its value", async t => {
  const s = await boot(t);
  const r = await s.cli("computers.tailnet.status");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual([r.data.enabled, r.data.tag], [false, "tag:vyre-agent"]);
  assert.equal(r.data.vault.item, "tailscale-agent-authkey");
  assert.ok(r.data.vault.exists === false || r.data.vault.exists === null, JSON.stringify(r.data.vault));
  assert.deepEqual(r.data.computers, []);
  // Off: a computer starts and nothing asks the vault for the key.
  await s.cli("computers.checkout", { agent: "kit" });
  const h = s.h.pool.joins.get("kit");
  if (h) await h.done;
  assert.equal(s.h.pool.joins.size, 0);
  assert.ok(!s.d.events.since(0, { limit: 1000 }).some(e => e.type === "vault.released" || e.type === "computer.joined"));
  const after = await s.cli("computers.tailnet.status");
  assert.deepEqual(after.data.computers, [{ agent: "kit", running: true, node: null, stableId: null }]);
});

test("computers: tailnet.set and status are the owner's, refused to agents and the assistant; set is saved to config", async t => {
  const s = await boot(t);
  for (const as of [s.kit, s.juno]) {
    assert.match((await as("computers.tailnet.set", { enabled: true })).error.message, /is an agent/);
    assert.match((await as("computers.tailnet.status")).error.message, /is an agent/);
  }
  assert.ok(s.d.registry.tools.get("computers.tailnet.set")?.presence, "computers.tailnet.set does not declare presence");
  const ok = await s.cli("computers.tailnet.set", { enabled: true });
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
  assert.deepEqual([ok.data.enabled, ok.data.tag], [true, "tag:vyre-agent"]);
  const saved = JSON.parse(fs.readFileSync(path.join(s.root, "config.json"), "utf8"));
  assert.deepEqual(saved.computers.tailnet, { enabled: true, tag: "tag:vyre-agent" });
  assert.equal(saved.computers.driver, "fake", "saving the switch dropped another computers key");
  assert.equal((await s.cli("computers.tailnet.status")).data.enabled, true);
});

test("computers: idle hand-back is 5 min by default, the owner's to change, live, and ends a take-over with why idle", async t => {
  const s = await boot(t);
  assert.deepEqual((await s.cli("computers.handback.status")).data, { minutes: 5, choices: [0, 2, 5, 15], warn_s: 10 });
  assert.match((await s.kit("computers.handback.set", { minutes: 0 })).error.message, /is an agent/);
  assert.ok((await s.cli("computers.handback.set", { minutes: 7 })).error, "a minutes value that is not a choice was saved");
  await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  const ok = await s.cli("computers.handback.set", { minutes: 2 });
  assert.equal(ok.error, undefined, JSON.stringify(ok.error));
  assert.equal(ok.data.minutes, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(s.root, "config.json"), "utf8"));
  assert.equal(saved.computers.handbackIdleMin, 2);
  assert.equal(saved.computers.driver, "fake", "saving the setting dropped another computers key");
  // The stream's pongs keep the lease (renew without input); the idle clock runs regardless.
  s.clock.t += 60_000; s.h.keyboard.renew("kit", "glass:laptop");
  s.clock.t += 50_000; await s.h.sweep();
  const warn = s.events().filter(e => e.type === "computer.idle-warning");
  assert.deepEqual(warn.map(e => e.payload), [{ agent: "kit", surface: "glass:laptop", at: 1_000 + 120_000 }]);
  assert.equal(warn[0].thread, s.kitThread);
  s.clock.t += 10_000; await s.h.sweep();
  assert.deepEqual((await s.module("computers.may-act", { agent: "kit" })).data, { ok: true });
  const back = s.events().filter(e => e.type === "computer.handed-back");
  assert.deepEqual(back.map(e => e.payload), [{ agent: "kit", surface: "glass:laptop", why: "idle", by: "owner", device: "glass", reason: "idle", idle_ms: 120_000 }]);
  assert.equal((await s.cli("computers.handback.set", { minutes: 0 })).data.minutes, 0);
});

test("computers: fill.begin and fill.end are the vault's only, and a take-over waits for a fill", async t => {
  const s = await boot(t);
  for (const as of [s.cli, s.kit, s.juno]) assert.equal((await as("computers.fill.begin", { agent: "kit", origin: "https://a.test" })).error.code, "no_such_tool");
  const other = await s.d.registry.call("computers.fill.begin", { agent: "kit", origin: "https://a.test" }, "module:glass");
  assert.equal(other.error.code, "denied");
  // The fake driver's computerd does not answer /shield, so a real begin fails closed here; the
  // fill itself is tested in fill.test.js. The vault reaches the tool and gets that answer.
  const vault = await s.d.registry.call("computers.fill.begin", { agent: "kit", origin: "https://a.test" }, "module:vault");
  assert.ok(vault.error, "a fill began with no computerd to cut the agent's sockets");
  assert.equal(s.h.shield.has("kit"), false);
  assert.equal((await s.d.registry.call("computers.fill.end", { agent: "kit", fill: "x" }, "module:vault")).data.ended, false);
  s.h.fills.open.set("kit", { id: "f1", origin: "https://a.test", token: "t".repeat(43), since: 0, expires: 60_000, cancel: () => {} });
  const take = await s.cli("computers.takeover", { agent: "kit", surface: "glass:laptop" });
  assert.equal(take.error.code, "busy");
  s.h.fills.open.delete("kit");
});

test("computers: node.agent is internal and for modules only, and knows no node that never joined", async t => {
  const s = await boot(t);
  assert.equal((await s.cli("computers.node.agent", { stableId: "nKit7CNTRL" })).error.code, "no_such_tool");
  assert.equal((await s.kit("computers.node.agent", { stableId: "nKit7CNTRL" })).error.code, "no_such_tool");
  assert.deepEqual((await s.module("computers.node.agent", { stableId: "nKit7CNTRL" })).data, { agent: null });
});

// ---- shared (browser-kind) computers: membership tools ---------------------------------

test("computers: all four member tools are on the PERSON_ONLY floor -- the same protection computers.takeover already stands behind, enforced by the harness's own rules layer and presence checks, not this module", () => {
  for (const tool of ["computers.member.add", "computers.member.remove", "computers.member.rotate", "computers.member.dispose"]) {
    assert.ok(PERSON_ONLY.has(tool), `${tool} is not on the PERSON_ONLY floor`);
  }
});

test("computers: computers.member.add reaches pool.js and the vault (there is no vault module running here, so it fails there, not at the tool's own gate)", async t => {
  const s = await boot(t);
  const r = await s.cli("computers.member.add", { computer: "browser-abc123", agent: "kit-1", name: "alice" });
  assert.ok(r.error, "add succeeded with no vault running to derive a token from");
  assert.match(r.error.message, /vault/i);
  // ensure() itself (seedMembersBeforeStart, before the container ever starts) is what hits the
  // vault. Since 29 Sep (reviewer LOW 2) a failed add for a brand-new member leaves no trace: the
  // row it made for this call is rolled back, not left half-built for the next attempt to trip
  // over -- a retry after fixing the vault starts from nothing, same as the very first try.
  assert.equal(s.h.pool.row("browser-abc123"), null, "a failed add left a row behind");
  assert.equal(s.h.pool.members("browser-abc123").length, 0, "a failed add left a member behind");
});
