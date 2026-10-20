// @ts-check
// The Computer tab's tools: the agents module's own refusal is the access rule, a new agent needs no setup step, and reset reaches one home only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { AgentUsers, MIGRATIONS } from "./agent-users.js";
import { registerAgentTools } from "./agent-tools.js";

function setup(t, { level = "edit" } = {}) {
  const db = open(path.join(tempHome(t), "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  /** @type {string[]} */ const ran = [];
  const ctl = {
    createUser: async (/** @type {any} */ u) => { ran.push(`create ${u.user}`); }, removeUser: async () => {},
    startScreen: async (/** @type {any} */ u) => { ran.push(`start ${u.user}`); }, stopScreen: async (/** @type {any} */ u) => { ran.push(`stop ${u.user}`); },
    wipeAgentHome: async (/** @type {any} */ u) => { ran.push(`wipe ${u.user}`); },
    terminals: async () => [{ name: "work", windows: 2 }],
  };
  const users = new AgentUsers({ db, ctl });
  /** @type {Map<string, (i: any, m: any) => Promise<any>>} */ const tools = new Map();
  /** @type {string[]} */ const asked = [];
  let held = false;
  registerAgentTools({ tool: (name, _d, _i, run) => tools.set(name, run), users, callers: ["deck"], held: () => held,
    terminal: (agent, session) => { ran.push(`terminal ${agent} ${session}`); return { ticket: "tt", path: "/term?ticket=tt" }; },
    watch: (agent, slow) => { ran.push(`ticket ${agent}${slow ? " slow" : ""}`); return { ticket: "tk", path: "/glass?ticket=tk", width: 1280, height: 800 }; },
    call: async (tool, input, opts) => { asked.push(`${tool} ${input.agent}${opts && opts.relay === true ? " relay" : ""}`); return tool === "agents.level" ? { data: { agent: input.agent, level } } : { error: { code: "no_such_tool", message: tool } }; } });
  return { users, tools, ran, asked, hold: (/** @type {boolean} */ v) => { held = v; } };
}
const call = (w, name, input) => /** @type {any} */ (w.tools.get(name))(input, {});

test("status of an agent with no place yet says none; wake makes the place and opens the screen; the Computer tab needs no setup step", async t => {
  const w = setup(t);
  assert.deepEqual(await call(w, "computers.agent.status", { agent: "ads" }), { agent: "ads", state: "none" });
  const live = await call(w, "computers.agent.wake", { agent: "ads" });
  assert.equal(live.state, "live");
  assert.deepEqual(w.ran, ["create ag20000", "start ag20000"]);
  assert.equal((await call(w, "computers.agent.status", { agent: "ads" })).state, "live");
  assert.equal((await call(w, "computers.agent.sleep", { agent: "ads" })).state, "asleep");
});

test("status says firstStart while the Space's computer has never been made, waking while it is being made, and the plain problem when it cannot run", async t => {
  const db = open(path.join(tempHome(t), "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  let space = { starting: false, first: true };
  /** @type {{ code: string, message: string } | null} */ let problem = null;
  const users = new AgentUsers({ db, ctl: { createUser: async () => {}, startScreen: async () => {} } });
  /** @type {Map<string, (i: any, m: any) => Promise<any>>} */ const tools = new Map();
  registerAgentTools({ tool: (name, _d, _i, run) => tools.set(name, run), users, callers: ["deck"], space: () => space, problem: () => problem,
    call: async (tool, input) => tool === "agents.level" ? { data: { agent: input.agent, level: "edit" } } : { error: { code: "no_such_tool", message: tool } } });
  const status = () => /** @type {any} */ (tools.get("computers.agent.status"))({ agent: "ads" }, {});
  assert.deepEqual(await status(), { agent: "ads", state: "none", firstStart: true });
  space = { starting: true, first: true };
  assert.deepEqual(await status(), { agent: "ads", state: "waking", firstStart: true });
  space = { starting: false, first: false };
  assert.deepEqual(await status(), { agent: "ads", state: "none" });
  problem = { code: "computer_unavailable", message: "The agent computer's image isn't on this server yet. Update the server to download it." };
  assert.deepEqual(await status(), { agent: "ads", state: "none", problem: problem.message, problemCode: "computer_unavailable" });
});

test("a caller the agents module refuses gets its refusal, and nothing starts", async t => {
  const w = setup(t, { level: "none" });
  for (const name of ["computers.agent.status", "computers.agent.wake", "computers.agent.sleep", "computers.agent.reset", "computers.agent.watch"]) {
    await assert.rejects(() => call(w, name, { agent: "ads" }), /cannot use that agent/, name);
  }
  assert.deepEqual(w.ran, []);
  assert.equal(w.users.row("ads"), null, "a refused wake made no place");
});

test("reset needs the right to edit, empties one home, and a user who may only use the agent cannot reset it", async t => {
  const w = setup(t, { level: "use" });
  await call(w, "computers.agent.wake", { agent: "ads" });
  await assert.rejects(() => call(w, "computers.agent.reset", { agent: "ads" }), /cannot change that agent/);
  assert.ok(!w.ran.some(x => x.startsWith("wipe")));
  const e = setup(t);
  await call(e, "computers.agent.wake", { agent: "ads" }); await call(e, "computers.agent.wake", { agent: "kit" });
  await call(e, "computers.agent.reset", { agent: "ads" });
  assert.deepEqual(e.ran.filter(x => x.startsWith("wipe")), ["wipe ag20000"], "only ads' home");
  assert.deepEqual(await call(setup(t), "computers.agent.reset", { agent: "ghost" }), { agent: "ghost", state: "none" });
});

test("sleep is refused while a person watches or has taken over, and a bad agent name is bad input", async t => {
  const w = setup(t);
  await call(w, "computers.agent.wake", { agent: "ads" });
  w.hold(true);
  await assert.rejects(() => call(w, "computers.agent.sleep", { agent: "ads" }), /watching or has taken over/);
  assert.equal(w.users.status("ads").state, "live");
  await assert.rejects(() => call(w, "computers.agent.status", { agent: "../root" }), /not an agent/);
  assert.ok(!w.asked.some(x => x.includes("../root")), "a bad name never reaches the agents module");
});

test("watching an agent wakes it and hands back a ticket for that agent alone; a caller without access gets neither", async t => {
  const w = setup(t);
  const r = await call(w, "computers.agent.watch", { agent: "ads", slow: true });
  assert.deepEqual(r, { ticket: "tk", path: "/glass?ticket=tk", width: 1280, height: 800 });
  assert.deepEqual(w.ran, ["create ag20000", "start ag20000", "ticket ads slow"]);
  const none = setup(t, { level: "none" });
  await assert.rejects(() => call(none, "computers.agent.watch", { agent: "ads" }), /cannot use that agent/);
  assert.deepEqual(none.ran, [], "no place, no screen and no ticket");
});

test("terminals are listed for someone who may use the agent; opening one needs the right to edit, a good name, and hands back a one-use ticket", async t => {
  const w = setup(t);
  await call(w, "computers.agent.wake", { agent: "ads" });
  assert.deepEqual(await call(w, "computers.agent.terminals", { agent: "ads" }), { terminals: [{ name: "work", windows: 2 }] });
  assert.deepEqual(await call(w, "computers.agent.terminal.open", { agent: "ads", session: "work" }), { ticket: "tt", path: "/term?ticket=tt" });
  for (const bad of ["", "a b", "x;y", "../x", "a".repeat(41)]) await assert.rejects(() => call(w, "computers.agent.terminal.open", { agent: "ads", session: bad }), /terminal name/, bad);
  const use = setup(t, { level: "use" });
  assert.equal((await call(use, "computers.agent.terminals", { agent: "ads" })).terminals.length, 0, "no place yet, so nothing to list");
  await assert.rejects(() => call(use, "computers.agent.terminal.open", { agent: "ads", session: "work" }), /cannot change that agent/);
  assert.ok(!use.ran.some(x => x.startsWith("terminal")), "no ticket for someone who may only use the agent");
});

test("the level of the agent is asked as the PERSON behind the call (a relayed call), never as the computers module, and the registry lets exactly that relay through", async t => {
  const w = setup(t, { level: "use" });
  await call(w, "computers.agent.status", { agent: "ads" });
  assert.deepEqual(w.asked, ["agents.level ads relay"], "agents.level refuses a caller that is not a person, so the call carries the person");
  const fs = await import("node:fs");
  const registry = fs.readFileSync(new URL("../modules/relay-allowed.js", import.meta.url), "utf8");
  assert.match(registry, /computers: \["agents\.level"\]/, "RELAY_ALLOWED lets the computers module relay the person to agents.level and to nothing else");
  const src = fs.readFileSync(new URL("./agent-tools.js", import.meta.url), "utf8");
  assert.match(src, /d\.call\("agents\.level", \{ agent \}, \{ relay: true \}\)/);
});
