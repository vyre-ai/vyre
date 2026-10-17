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
  const server = createAgentd({ token: "tok", run: async argv => { ran.push(argv); }, writeFile: ((p, c) => { files[String(p)] = String(c); }) });
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
  assert.ok(w.ran.some(a => a[0] === "mkdir" && a.includes("/home/ag20000")));
  assert.ok(w.ran.some(a => a.includes("Xvnc")));
  assert.ok(w.ran.some(a => a[0] === "pkill" && a.includes("chromium")));
  assert.ok(w.ran.some(a => a[0] === "find" && a.includes("/home/ag20000")));
  assert.ok(w.ran.filter(a => a[0] === "find").length === 2, "wipe and remove each empty folders");
});

test("the VNC password reaches a file in the agent's run folder, is derived per agent, and is on no command line", async t => {
  const w = await world(t);
  await w.ctl.startScreen(U);
  const pw = vncPasswordFor("k".repeat(32), "ads");
  assert.equal(w.files["/run/agents/ag20000/vnc.plain"], pw);
  assert.notEqual(pw, vncPasswordFor("k".repeat(32), "kit"), "every agent has its own");
  assert.ok(!w.ran.flat().join(" ").includes(pw), "never an argument");
  assert.equal(w.ran[0][0], "agentd-vncpass", "converted before Xvnc starts");
});

test("a wrong token or a body outside the agent ranges is refused and runs nothing", async t => {
  const w = await world(t);
  const bad = await fetch(`${w.url}/agents/create`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
  assert.equal(bad.status, 401);
  for (const body of [{ user: "root", uid: 0, display: 20 }, { user: "ag20000", uid: 1000, display: 20 }, { user: "ag20000", uid: 20000, display: 3 }]) {
    const r = await fetch(`${w.url}/agents/create`, { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await fetch(`${w.url}/agents/shell`, { method: "POST", headers: { authorization: "Bearer tok" }, body: "{}" })).status, 404);
  assert.equal(w.ran.length, 0);
  await assert.rejects(() => agentdCtl({ url: w.url, token: "wrong", vncKey: async () => "k" }).createUser(U), /could not create \(401/);
});
