// @ts-check
// The wire between vyred and agentd: the Ctl port over HTTP, against the real agentd server with a recording runner. No container, no real commands.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { startAgentd } from "./image/agentd-main.js";
import { callAgentd } from "./image/agentd-client.js";
import { agentdCtl, execTransport, vncPasswordFor } from "./agentd-ctl.js";

async function world(t) {
  /** @type {string[][]} */ const ran = [];
  /** @type {Record<string, string>} */ const files = {};
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-agentd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "agentd.sock"), tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "t".repeat(40), { mode: 0o400 });
  const server = startAgentd({ socket, tokenFile, run: async argv => { ran.push(argv); if (/** @type {any} */ (argv).input !== undefined) files["stdin"] = /** @type {any} */ (argv).input; } });
  await new Promise(r => server.on("listening", () => r(null)));
  t.after(() => server.close());
  // the same call vyred makes with `docker exec`, here run in-process against the real unix socket
  const exec = async (/** @type {string} */ input) => {
    const req = JSON.parse(input);
    const res = await callAgentd({ socket, token: "t".repeat(40), action: req.action, body: JSON.stringify(req.body) });
    let body = null; try { body = JSON.parse(res.text); } catch { /* none */ }
    return { stdout: JSON.stringify({ status: res.status, body }) };
  };
  const ctl = agentdCtl({ transport: execTransport(exec), vncKey: async () => "k".repeat(32) });
  return { ctl, ran, files, socket, tokenFile, exec: (/** @type {string} */ action, /** @type {any} */ body, /** @type {string} */ token = "t".repeat(40)) => callAgentd({ socket, token, action, body: JSON.stringify(body) }) };
}
const U = { agentId: "ads", user: "ag20000", uid: 20000, display: 20 };

test("the Ctl port reaches agentd: create, start, stop, wipe and remove each run their plan", async t => {
  const w = await world(t);
  await w.ctl.createUser(U);
  await w.ctl.startScreen(U);
  await w.ctl.stopScreen(U);
  await w.ctl.wipeHome(U);
  await w.ctl.removeUser(U);
  assert.ok(w.ran.some(a => a.includes("/usr/bin/mkdir") && a.includes("/home/ag20000")));
  assert.ok(w.ran.some(a => a.includes("/usr/bin/Xvnc")));
  assert.ok(w.ran.some(a => a.includes("/usr/bin/pkill") && a.includes("chromium")));
  assert.ok(w.ran.some(a => a.includes("/usr/bin/find") && a.includes("/home/ag20000")));
  assert.ok(w.ran.filter(a => a.includes("/usr/bin/find")).length === 2, "wipe and remove each empty folders");
});

test("the VNC password reaches a helper that runs as the agent, on standard input, is derived per agent, and is on no command line", async t => {
  const w = await world(t);
  await w.ctl.startScreen(U);
  const pw = vncPasswordFor("k".repeat(32), "ads");
  assert.equal(w.files.stdin, pw);
  assert.notEqual(pw, vncPasswordFor("k".repeat(32), "kit"), "every agent has its own");
  assert.ok(!w.ran.flat().join(" ").includes(pw), "never an argument");
  assert.ok(w.ran[0].join(" ").startsWith("/usr/bin/setpriv --reuid=20000 ") && w.ran[0].includes("/usr/local/bin/agentd-vncpass"), "run as the agent, before Xvnc starts");
});

test("agentd listens on a unix socket that only root can open: mode 0600, no TCP port, and the token is not in its environment", async t => {
  const w = await world(t);
  assert.equal(fs.statSync(w.socket).mode & 0o777, 0o600);
  assert.equal(fs.statSync(w.socket).isSocket(), true);
  assert.ok(!Object.values(process.env).some(v => v === "t".repeat(40)), "the token came from the file, not the environment");
});

test("a wrong token or a body outside the agent ranges is refused and runs nothing, and an action that is not one is not even sent", async t => {
  const w = await world(t);
  assert.equal((await w.exec("create", {}, "nope")).status, 401);
  for (const body of [{ user: "root", uid: 0, display: 20 }, { user: "ag20000", uid: 1000, display: 20 }, { user: "ag20000", uid: 20000, display: 3 }, { user: "ag20001", uid: 20000, display: 20 }]) {
    assert.equal((await w.exec("create", body)).status, 400, JSON.stringify(body));
  }
  await assert.rejects(() => w.exec("shell", {}), /not an agentd action/);
  assert.equal(w.ran.length, 0);
});

test("a token file that holds no token stops agentd from starting", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-agentd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "token"), "short");
  assert.throws(() => startAgentd({ socket: path.join(dir, "s.sock"), tokenFile: path.join(dir, "token") }), /holds no token/);
});

test("a screen ticket goes to agentd as the agent's triple and the ticket, nothing else", async () => {
  /** @type {any[]} */ const sent = [];
  const ctl = agentdCtl({ transport: async (a, b) => { sent.push([a, b]); return { status: 200, json: { ok: true } }; }, vncKey: async () => "k".repeat(32) });
  await /** @type {any} */ (ctl).screenTicket({ agentId: "ads", user: "ag20001", uid: 20001, display: 21 }, "t".repeat(32));
  assert.deepEqual(sent, [["ticket", { user: "ag20001", uid: 20001, display: 21, ticket: "t".repeat(32) }]]);
});

test("terminals are asked for as the agent's triple and come back as a list; a terminal ticket carries the session", async () => {
  /** @type {any[]} */ const sent = [];
  const ctl = agentdCtl({ transport: async (a, b) => { sent.push([a, b]); return a === "terminals" ? { status: 200, json: { sessions: [{ name: "work", windows: 1 }] } } : { status: 200, json: { ok: true } }; }, vncKey: async () => "k".repeat(32) });
  const u = { agentId: "ads", user: "ag20001", uid: 20001, display: 21 };
  assert.deepEqual(await /** @type {any} */ (ctl).terminals(u), [{ name: "work", windows: 1 }]);
  await /** @type {any} */ (ctl).terminalTicket(u, "t".repeat(32), "work");
  assert.deepEqual(sent, [["terminals", { user: "ag20001", uid: 20001, display: 21 }], ["ticket", { user: "ag20001", uid: 20001, display: 21, ticket: "t".repeat(32), session: "work" }]]);
  const bad = agentdCtl({ transport: async () => ({ status: 502, json: null }), vncKey: async () => "k" });
  await assert.rejects(() => /** @type {any} */ (bad).terminals(u), /could not list terminals/);
});

test("a Chrome ticket goes to agentd as the agent's triple, the ticket and the kind cdp", async () => {
  /** @type {any[]} */ const sent = [];
  const ctl = agentdCtl({ transport: async (a, b) => { sent.push([a, b]); return { status: 200, json: { ok: true } }; }, vncKey: async () => "k".repeat(32) });
  await /** @type {any} */ (ctl).cdpTicket({ agentId: "ads", user: "ag20001", uid: 20001, display: 21 }, "t".repeat(32));
  assert.deepEqual(sent, [["ticket", { user: "ag20001", uid: 20001, display: 21, ticket: "t".repeat(32), kind: "cdp" }]]);
});
