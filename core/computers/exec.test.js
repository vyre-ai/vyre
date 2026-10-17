// @ts-check
// computers.exec: a command run as an agent's own Linux user. The plan (what is allowed in, what the child gets), the wire through the real agentd server with a recording runner, the
// AgentUsers method and the tool with its edit-level check. No container and no real command runs.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { open, migrate } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { startAgentd } from "./image/agentd-main.js";
import { callAgentd } from "./image/agentd-client.js";
import { planExec, homeOf, EXEC_LIMITS } from "./image/agentd.js";
import { agentdCtl, execTransport } from "./agentd-ctl.js";
import { AgentUsers, MIGRATIONS } from "./agent-users.js";
import { registerAgentTools } from "./agent-tools.js";

const U = { user: "ag20000", uid: 20000, display: 20 };
const HOME = homeOf("ag20000");

test("exec plan: the command runs as the agent's uid with nothing extra, a clean environment, in a folder inside its home", () => {
  const a = planExec(U, { argv: ["/usr/bin/git", "status"], cwd: `${HOME}/work`, env: { API_BASE: "x" } });
  const s = a.join(" ");
  assert.match(s, /^\/usr\/bin\/setpriv --reuid=20000 --regid=20000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs/);
  assert.match(s, /\/usr\/bin\/env -i /);
  for (const v of [`HOME=${HOME}`, "USER=ag20000", "PATH=/usr/local/bin:/usr/bin:/bin", "DISPLAY=:20", "API_BASE=x"]) assert.ok(a.includes(v), v);
  assert.deepEqual(a.slice(-5), ["/usr/bin/env", "-C", `${HOME}/work`, "/usr/bin/git", "status"]);
  assert.ok(!a.includes("/bin/sh") && !a.includes("sh"), "no shell");
  assert.deepEqual(planExec(U, { argv: ["/usr/bin/id"] }).slice(-3, -1), ["-C", HOME], "the home is the default folder");
});

test("exec plan: what a caller sends cannot change who runs it or where, and cannot set a forbidden variable", () => {
  const bad = (/** @type {any} */ req, /** @type {RegExp} */ re) => assert.throws(() => planExec(U, req), re);
  bad({ argv: [] }, /1 to 64/);
  bad({ argv: "ls" }, /1 to 64/);
  bad({ argv: ["ls"] }, /absolute path/);
  bad({ argv: ["/usr/bin/../../bin/sh"] }, /absolute path/);
  bad({ argv: ["/usr/bin/id", "a\0b"] }, /text arguments/);
  bad({ argv: ["/usr/bin/id", "x".repeat(EXEC_LIMITS.argvBytes)] }, /too long/);
  bad({ argv: ["/usr/bin/id"], cwd: "/etc" }, /inside the agent's home/);
  bad({ argv: ["/usr/bin/id"], cwd: `${HOME}/../ag20001/home` }, /inside the agent's home/);
  bad({ argv: ["/usr/bin/id"], cwd: "/var/lib/vyre/agents/ag20001/home" }, /inside the agent's home/);
  bad({ argv: ["/usr/bin/id"], cwd: HOME + "x" }, /inside the agent's home/);
  for (const k of ["PATH", "HOME", "USER", "DISPLAY", "XAUTHORITY", "LD_PRELOAD", "BASH_ENV", "NODE_OPTIONS", "PYTHONPATH"]) bad({ argv: ["/usr/bin/id"], env: { [k]: "x" } }, /cannot be set/);
  bad({ argv: ["/usr/bin/id"], env: { lower: "x" } }, /cannot be set/);
  bad({ argv: ["/usr/bin/id"], env: { A: "a\0" } }, /not usable/);
  bad({ argv: ["/usr/bin/id"], env: ["A"] }, /NAME: value/);
  assert.throws(() => planExec({ ...U, uid: 1000, user: "ag1000" }, { argv: ["/usr/bin/id"] }), /not one of the agent users/);
  assert.throws(() => planExec({ ...U, user: "root" }, { argv: ["/usr/bin/id"] }), /agent user name/);
});

async function wire(/** @type {any} */ t, /** @type {any} */ exec) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-exec-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "agentd.sock"), tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "t".repeat(40), { mode: 0o400 });
  const server = startAgentd({ socket, tokenFile, relayPort: 0, run: async () => {}, exec });
  await new Promise(r => server.on("listening", () => r(null)));
  t.after(() => server.close());
  const ex = async (/** @type {string} */ input) => {
    const req = JSON.parse(input);
    const res = await callAgentd({ socket, token: "t".repeat(40), action: req.action, body: JSON.stringify(req.body) });
    let body = null; try { body = JSON.parse(res.text); } catch { /* none */ }
    return { stdout: JSON.stringify({ status: res.status, body }) };
  };
  return agentdCtl({ transport: execTransport(ex), vncKey: async () => "k" });
}
const P = { agentId: "ads", ...U };

test("exec wire: the plan and the input reach the runner, the answer comes back, and a bad request never reaches it", async t => {
  /** @type {any[]} */ const seen = [];
  const ctl = await wire(t, async (/** @type {string[]} */ argv, /** @type {any} */ o) => { seen.push({ argv, o }); return { code: 0, signal: null, stdout: "ok\n", stderr: "", truncated: false }; });
  const r = await ctl.exec(P, { argv: ["/usr/bin/echo", "hi"], stdin: "in", timeoutMs: 5000 });
  assert.deepEqual(r, { code: 0, signal: null, stdout: "ok\n", stderr: "", truncated: false });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].argv.includes("--reuid=20000"));
  assert.deepEqual(seen[0].o, { stdin: "in", timeoutMs: 5000 });
  for (const req of [{ argv: ["sh"] }, { argv: ["/usr/bin/id"], cwd: "/etc" }, { argv: ["/usr/bin/id"], timeoutMs: 600_000 }, { argv: ["/usr/bin/id"], timeoutMs: 5, }, { argv: ["/usr/bin/id"], stdin: "x".repeat(EXEC_LIMITS.stdinBytes + 1) }]) {
    await assert.rejects(() => ctl.exec(P, /** @type {any} */ (req)), /could not run that/);
  }
  assert.equal(seen.length, 1, "nothing bad was run");
  await assert.rejects(() => ctl.exec({ ...P, uid: 1000, user: "ag1000", display: 20 }, { argv: ["/usr/bin/id"] }), /could not run that/);
});

function tools(/** @type {any} */ t, level = "edit") {
  const db = open(path.join(tempHome(t), "t.db"));
  t.after(() => db.close());
  migrate(db, "computers", MIGRATIONS);
  /** @type {any[]} */ const ran = [];
  const ctl = { createUser: async () => {}, removeUser: async () => {}, startScreen: async () => {}, stopScreen: async () => {}, wipeHome: async () => {},
    exec: async (/** @type {any} */ u, /** @type {any} */ req) => { ran.push([u.user, req]); return { code: 0, signal: null, stdout: "", stderr: "", truncated: false }; } };
  const users = new AgentUsers({ db, ctl });
  /** @type {Map<string, any>} */ const map = new Map();
  registerAgentTools({ tool: (n, _d, _i, run) => map.set(n, run), users, callers: ["deck"], call: async tool => tool === "agents.level" ? { data: { level } } : { error: { code: "no_such_tool", message: tool } } });
  return { users, ran, call: (/** @type {any} */ i) => map.get("computers.exec")(i, {}) };
}

test("exec tool: it needs the right to edit the agent; use alone is refused and nothing runs", async t => {
  const w = tools(t, "use");
  await assert.rejects(() => w.call({ agent: "ads", argv: ["/usr/bin/id"] }), /cannot change that agent/);
  const none = tools(t, "none");
  await assert.rejects(() => none.call({ agent: "ads", argv: ["/usr/bin/id"] }));
  assert.deepEqual([...w.ran, ...none.ran], []);
});

test("exec tool: with edit it makes the agent's place on first use, runs as that agent, and counts as use; a bad agent name is bad input", async t => {
  const w = tools(t, "edit");
  const r = await w.call({ agent: "ads", argv: ["/usr/bin/id"], env: { A: "1" }, stdin: "x" });
  assert.equal(r.code, 0);
  assert.deepEqual(w.ran[0][0], "ag20000");
  assert.deepEqual(w.ran[0][1], { argv: ["/usr/bin/id"], env: { A: "1" }, stdin: "x" });
  await assert.rejects(() => w.call({ agent: "../x", argv: ["/usr/bin/id"] }), /is not an agent/);
});
