// @ts-check
// The box reads the paired Mac through the link (docs/work/federation.md, design 1 to 3): the Mac
// holds link.serve open, the box's modules ask with link.macs.call, and only the read tools in
// core/link/allow.js cross, checked at both ends. Nothing the Mac answers is stored on the box.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSIONS } from "./fixtures/corpus.js";
import { OWNER, MAC, wait, until, pair } from "./link-harness.js";

/** link.macs.call as a module on the box would make it. */
const ask = (s, tool, input = {}, extra = {}) => s.box.registry.call("link.macs.call", { tool, input, ...extra }, "module:test");
/** The box's view of its Macs, once the Mac holds a request. */
const polling = s => until(async () => { const m = (await s.boxCall("link.macs")).data; return m.length === 1 && m[0].online && m; });
const recallRows = s => Number(/** @type {any} */ (s.box.registry.deps.db.prepare("SELECT COUNT(*) AS n FROM recall_sessions").get()).n);

test("link federation: the box reads the Mac's catalog and sessions, labelled with the Mac, and stores none of it", async t => {
  const s = await pair(t, { macTranscripts: true });
  const ix = await s.macCall("recall.index");
  assert.ok(!ix.error, JSON.stringify(ix.error));
  const macs = await polling(s);
  assert.equal(macs[0].name, "test-mac");
  assert.equal(macs[0].node, "test-mac");
  assert.equal(typeof macs[0].lastServe, "number");

  const sessions = await ask(s, "recall.sessions", { limit: 50 });
  assert.ok(!sessions.error, JSON.stringify(sessions.error));
  assert.equal(sessions.data.length, 1);
  const [one] = sessions.data;
  assert.equal(one.ok, true, JSON.stringify(one.error));
  assert.equal(one.name, "test-mac");
  assert.equal(one.mac, macs[0].mac);
  assert.deepEqual(one.data.map(x => x.id).sort(), SESSIONS.map(x => x.id).sort());

  const catalog = (await ask(s, "projects.catalog", { limit: 50 })).data[0];
  assert.equal(catalog.ok, true, JSON.stringify(catalog.error));
  assert.equal(catalog.name, "test-mac");
  assert.ok(catalog.data.sessions.some(x => x.name === "Harlow site rebuild"), JSON.stringify(catalog.data).slice(0, 400));

  const hits = (await ask(s, "recall.search", { q: "intake form", limit: 3 })).data[0];
  assert.equal(hits.ok, true);
  assert.equal(hits.data[0].name, "Harlow site rebuild");
  const th = (await ask(s, "recall.thread", { session: hits.data[0].session })).data[0];
  assert.equal(th.ok, true);
  assert.equal(th.data.turns.length, 4);

  // The Mac's own error comes back as that Mac's answer, not as a failure of the call.
  const bad = (await ask(s, "recall.thread", { session: "no-such-session" })).data[0];
  assert.equal(bad.ok, false);
  assert.ok(bad.error && bad.error.code !== "timeout" && bad.error.code !== "mac_offline", JSON.stringify(bad.error));

  // Nothing about the Mac is in the box's store: no recall rows, no copy of what was said.
  assert.equal(recallRows(s), 0);
  const events = JSON.stringify(s.box.registry.deps.db.prepare("SELECT * FROM events").all());
  assert.ok(!events.includes("intake form") && !events.includes("Harlow site rebuild"));
});

test("link federation: only the read tools cross, refused by the box and by the Mac", async t => {
  const s = await pair(t);
  await polling(s);
  for (const tool of ["system.echo", "vault.get", "link.peers", "threads.start"]) {
    const r = await ask(s, tool, { text: "hi" });
    assert.equal(r.error && r.error.code, "denied", `${tool}: ${JSON.stringify(r)}`);
  }
  // Nothing was queued: the Mac is still holding its request, with nothing to answer.
  assert.equal((await ask(s, "threads.list")).data[0].ok, true);

  // Only modules may ask. The person, a surface, Claude and a tailnet caller all get no such tool.
  for (const caller of ["cli", "deck", "local", "mcp", `tailnet:${OWNER}`]) {
    const r = await s.box.registry.call("link.macs.call", { tool: "recall.sessions" }, caller, { peer: MAC });
    assert.equal(r.error && r.error.code, "no_such_tool", caller);
  }
  assert.ok(!s.box.registry.listTools().some(x => x.name === "link.macs.call"), "internal tools are not listed");
});

test("link federation: a box that asks for more still gets refused by the Mac", async t => {
  // The box's list is widened for this test only; the Mac's own check is what answers.
  const s = await pair(t, { allow: ["system.echo", "recall.sessions"] });
  await polling(s);
  const r = (await ask(s, "system.echo", { text: "hi" })).data[0];
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "denied");
  assert.match(r.error.message, /not answered through the link/);
  // The loop carries on after a refusal.
  assert.equal((await ask(s, "recall.sessions")).data[0].ok, true);
});

test("link federation: link.serve and link.reply need the Mac's key from the Mac's node", async t => {
  const s = await pair(t);
  await polling(s);
  const asMac = (tool, input) => s.boxCall(tool, input, `tailnet:${OWNER}`, { peer: MAC });
  assert.deepEqual((await asMac("link.serve", { key: "not-the-key" })).data, { paired: false });
  assert.deepEqual((await asMac("link.reply", { key: "not-the-key", id: "x", result: { data: 1 } })).data, { paired: false });
  // The Mac's real key from another node, or from the box's own terminal, is refused too.
  const key = JSON.parse((await import("node:fs")).readFileSync((await import("node:path")).join(s.macRoot, "link.json"), "utf8")).key;
  assert.deepEqual((await s.boxCall("link.serve", { key }, `tailnet:${OWNER}`, { peer: { login: OWNER, node: "test-phone", stableId: "nPHONE" } })).data, { paired: false });
  assert.deepEqual((await s.boxCall("link.serve", { key }, "cli")).data, { paired: false });
  // An answer to a question nobody asked is dropped.
  assert.deepEqual((await asMac("link.reply", { key, id: "no-such-question", result: { data: 1 } })).data, { ok: false });
});

test("link federation: an offline Mac answers mac_offline at once, a Mac gone mid-call times out, and both recover", async t => {
  const s = await pair(t);
  await polling(s);
  // The tailnet goes away while the Mac holds its request: the box does not know yet, so a
  // question goes to a request that no longer reaches the Mac, and times out.
  await s.stopTailnet();
  const gone = (await ask(s, "recall.sessions", {}, { timeout: 500 })).data[0];
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, "timeout");

  // Once the Mac has not asked for a while, it is offline, and nothing waits for it.
  const offline = await until(async () => { const r = (await ask(s, "recall.sessions", {}, { timeout: 100 })).data[0]; return r.error && r.error.code === "mac_offline" && r; });
  assert.match(offline.error.message, /test-mac/);
  const t0 = Date.now();
  assert.equal((await ask(s, "recall.sessions", {}, { timeout: 15_000 })).data[0].error.code, "mac_offline");
  assert.ok(Date.now() - t0 < 1000, "mac_offline answers without waiting");
  const macs = await until(async () => { const m = (await s.boxCall("link.macs")).data; return m[0].online === false && m; });
  assert.equal(macs.length, 1);
  assert.equal((await s.macCall("link.status")).data.serving, false);

  // The box is back: the heartbeat (100 ms here) restarts the loop.
  await s.startTailnet();
  await polling(s);
  assert.equal((await ask(s, "recall.sessions")).data[0].ok, true);
  assert.equal((await s.macCall("link.status")).data.serving, true);
});

test("link federation: unpairing on the box stops the Mac's loop and empties link.macs", async t => {
  const s = await pair(t);
  const [m] = await polling(s);
  assert.ok(!(await s.boxCall("link.unpair", { id: m.mac })).error);
  assert.deepEqual((await s.boxCall("link.macs")).data, []);
  assert.deepEqual((await ask(s, "recall.sessions")).data, []);
  await until(async () => { const st = (await s.macCall("link.status")).data; return !st.linked && !st.serving; });
  // And it stays stopped: a heartbeat later, nothing is polling.
  await wait(300);
  assert.equal((await s.macCall("link.status")).data.serving, false);
  assert.deepEqual((await s.boxCall("link.macs")).data, []);
});

test("link federation: unpairing from the Mac stops its loop, and pairing again starts it", async t => {
  const s = await pair(t);
  await polling(s);
  const u = await s.macCall("link.unpair");
  assert.equal(u.data.unpaired, true);
  await until(async () => (await s.macCall("link.status")).data.serving === false);
  assert.deepEqual((await s.boxCall("link.macs")).data, []);
  const p = await s.macCall("link.pair", { box: s.address });
  assert.ok(!(await s.boxCall("link.pair.approve", { code: p.data.code })).error);
  await polling(s);
  assert.equal((await ask(s, "threads.list")).data[0].ok, true);
});
