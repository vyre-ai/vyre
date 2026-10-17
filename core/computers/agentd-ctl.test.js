// @ts-check
// The wire between vyred and agentd: the Ctl port over HTTP, against the real agentd server with a recording runner. No container, no real commands.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentd } from "./image/agentd-server.js";
import { agentdCtl, vncPasswordFor } from "./agentd-ctl.js";

async function world(t) {
  /** @type {string[][]} */ const ran = [];
  /** @type {Record<string, string>} */ const files = {};
  const server = createAgentd({ token: "tok", run: async argv => { ran.push(argv); if (/** @type {any} */ (argv).input !== undefined) files["stdin"] = /** @type {any} */ (argv).input; } });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(null)));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const ctl = agentdCtl({ url, token: "tok", vncKey: async () => "k".repeat(32) });
  return { ctl, ran, files, url };
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

test("a wrong token or a body outside the agent ranges is refused and runs nothing", async t => {
  const w = await world(t);
  const bad = await fetch(`${w.url}/agents/create`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
  assert.equal(bad.status, 401);
  for (const body of [{ user: "root", uid: 0, display: 20 }, { user: "ag20000", uid: 1000, display: 20 }, { user: "ag20000", uid: 20000, display: 3 }, { user: "ag20001", uid: 20000, display: 20 }]) {
    const r = await fetch(`${w.url}/agents/create`, { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await fetch(`${w.url}/agents/shell`, { method: "POST", headers: { authorization: "Bearer tok" }, body: "{}" })).status, 404);
  assert.equal(w.ran.length, 0);
  await assert.rejects(() => agentdCtl({ url: w.url, token: "wrong", vncKey: async () => "k" }).createUser(U), /could not create \(401/);
});
