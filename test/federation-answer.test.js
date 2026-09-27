// @ts-check
// The person on the box answers a Mac session's ask (docs/adr/0021-box-reads-the-mac.md, "v2").
// Every ask a paired Mac raises reaches the box's bus labelled with the Mac. threads.answer on the
// box, for the person, goes to that Mac with an assertion signed by the box's key; the Mac checks
// it against the key it pinned at pairing before it runs threads.answer as "link:box". Agents,
// MCP, guests and modules never reach the Mac. The checks one by one: core/link/assert.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { KEY_FILE } from "../core/link/assert.js";
import { present } from "./helpers.js";
import { until, pair } from "./link-harness.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);

/** A box (harlow-box) and a Mac (alex-mac) with the Switchboard's fake claude, the Mac holding its request. */
async function world(t) {
  const env = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  process.env.VYRE_CLAUDE_BIN = FAKE;
  delete process.env.FAKE_CLAUDE_LOG;
  t.after(() => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const s = await pair(t, { macTranscripts: [], boxName: "harlow-box", macHost: "alex-mac" });
  const heard = [];
  t.after(s.box.events.on("*", e => heard.push(e)));
  const w = { ...s, heard, ran: /** @type {any[]} */ ([]), macd: s.mac };
  watchMac(w, s.mac);
  await online(w);
  return w;
}
/** Record every tool the Mac's registry runs, to show what reached it. */
function watchMac(w, mac) {
  const real = mac.registry.call.bind(mac.registry);
  mac.registry.call = (tool, input, caller, meta) => { w.ran.push({ tool, input, caller }); return real(tool, input, caller, meta); };
  w.macd = mac;
}
const online = w => until(async () => { const m = (await w.boxCall("link.macs")).data; return m.length === 1 && m[0].online && m; });
const linkFile = w => path.join(w.macRoot, "link.json");
const saved = w => JSON.parse(fs.readFileSync(linkFile(w), "utf8"));
const answersRun = w => w.ran.filter(r => r.tool === "threads.answer");

/** A session on the Mac that asks to run a command, and the box's copy of its ask.raised. */
async function macAsk(w, command = "ls") {
  const started = await w.macd.registry.call("threads.start", { cwd: w.macWork, prompt: `bash ${command}`, surface: "capsule" }, "capsule");
  assert.ok(!started.error, JSON.stringify(started.error));
  const thread = started.data.id;
  const raised = await until(() => w.heard.find(e => e.type === "ask.raised" && e.thread === thread));
  return { thread, raised, ask: raised.payload.ask };
}

/** Stop the Mac's vyred, change its link.json, and start it again in the same home. */
async function restartMac(t, w, change) {
  await w.macd.stop();
  fs.writeFileSync(linkFile(w), JSON.stringify(change(saved(w)), null, 2) + "\n", { mode: 0o600 });
  const mac = await start({ presence: present, root: w.macRoot, log: () => {} });
  t.after(() => mac.stop());
  watchMac(w, mac);
  // The box may still count the stopped vyred as online: wait for the new one to check in and serve.
  await until(async () => { const st = (await mac.registry.call("link.status", {}, "cli")).data; return st.reachable && st.serving; });
  await online(w);
  return mac;
}

test("federation answer: a Mac's ask reaches the box labelled with the Mac, and the person's answer there reaches the Mac and answers it", async t => {
  const w = await world(t);
  // Pairing pinned the box's key and told the Mac its own node.
  const boxPub = crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.from(JSON.parse(fs.readFileSync(path.join(w.boxRoot, KEY_FILE), "utf8")).private, "base64url"), format: "der", type: "pkcs8" }))
    .export({ format: "der", type: "spki" }).toString("base64url");
  assert.deepEqual([saved(w).box.assertKey, saved(w).self], [boxPub, "nMAC"]);
  assert.equal(fs.statSync(path.join(w.boxRoot, KEY_FILE)).mode & 0o777, 0o600);

  const { thread, raised, ask } = await macAsk(w);
  assert.deepEqual([raised.payload.source, raised.payload.machine, raised.payload.node, raised.payload.tool, raised.project], ["mac", "alex-mac", "nMAC", "Bash", null]);
  assert.equal((await w.boxCall("threads.asks", {}, "deck")).data.length, 0, "the box keeps no ask of the Mac's");

  const r = await w.boxCall("threads.answer", { ask, decision: "allow" }, "deck");
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual(r.data, { ask, answered: true, decision: "allow", source: "mac", machine: "alex-mac" });
  const [ran] = answersRun(w);
  assert.deepEqual([ran.caller, ran.input], ["link:box", { ask, decision: "allow", surface: "box:deck" }]);
  // The end of the ask comes back too, so every surface closes its card.
  const answered = await until(() => w.heard.find(e => e.type === "ask.answered" && e.thread === thread));
  assert.deepEqual([answered.payload.ask, answered.payload.decision, answered.payload.by, answered.payload.source, answered.payload.machine], [ask, "allow", "box:deck", "mac", "alex-mac"]);
  // An answer follows nothing: only a send does.
  assert.equal((await w.macd.registry.call("link.status", {}, "cli")).data.following, 0);

  // An ask the Mac no longer has is its last word, passed through, not retried.
  const gone = await w.boxCall("threads.answer", { ask: "zzzzzzzzzzzzzzzzzz", decision: "deny", machine: "alex-mac" }, "deck");
  assert.match(gone.error.message, /^no ask zzzz/);
  assert.equal(answersRun(w).length, 2);
  // An ask no Mac raised, and no machine named: the box answers as before, and no Mac is asked.
  const none = await w.boxCall("threads.answer", { ask: "yyyyyyyyyyyyyyyyyy", decision: "deny" }, "deck");
  assert.match(none.error.message, /^no ask yyyy/);
  assert.equal(answersRun(w).length, 2);
});

test("federation answer: the owner's phone answers a question on the Mac, the device named in what the box signs", async t => {
  const w = await world(t);
  const { ask } = await macAsk(w, "npm test");
  const r = await w.boxCall("threads.answer", { ask, decision: "deny", message: "not now" }, "tailnet:owner@example.com", { peer: { stableId: "nPHONE", node: "test-phone", login: "owner@example.com" } });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual([r.data.answered, r.data.decision, r.data.machine], [true, "deny", "alex-mac"]);
  assert.deepEqual(answersRun(w)[0].input, { ask, decision: "deny", message: "not now", surface: "box:tailnet:owner@example.com" });
});

test("federation answer: an agent, MCP, a guest or a module on the box never reaches the Mac", async t => {
  const w = await world(t);
  const { ask } = await macAsk(w);
  for (const who of ["mcp", "mcp:agent:kit", "harness:agent:juno", "tailnet-guest:friend@example.com", "tailnet:agent:kit"]) {
    const r = await w.boxCall("threads.answer", { ask, decision: "allow", machine: "alex-mac" }, who);
    assert.equal(r.error && r.error.code, "denied", who);
  }
  // A module may call threads.answer, for the box's own asks: it never federates.
  const byModule = await w.boxCall("threads.answer", { ask, decision: "allow", machine: "alex-mac" }, "module:test");
  assert.match(byModule.error.message, /^no ask/);
  // link.macs.call itself refuses the write without the person's `as`.
  const direct = await w.boxCall("link.macs.call", { tool: "threads.answer", input: { ask, decision: "allow" } }, "module:test");
  assert.equal(direct.error.code, "denied");
  assert.equal(answersRun(w).length, 0, "the Mac never saw any of them");
  assert.equal((await w.macd.registry.call("threads.asks", {}, "capsule")).data.length, 1, "the ask is still open on the Mac");
});

test("federation answer: a Mac paired before answers crossed pins the box's key once, over the pinned channel", async t => {
  const w = await world(t);
  const pinned = saved(w).box.assertKey;
  await restartMac(t, w, v => { const { self: _s, ...rest } = v; const { assertKey: _k, ...box } = v.box; return { ...rest, box }; });
  await until(() => saved(w).box.assertKey && saved(w).self);
  assert.deepEqual([saved(w).box.assertKey, saved(w).self], [pinned, "nMAC"]);
  const { ask } = await macAsk(w);
  const r = await w.boxCall("threads.answer", { ask, decision: "allow" }, "deck");
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal(r.data.answered, true);
});

test("federation answer: a Mac that pinned another key refuses the box's answer, and never replaces the pin", async t => {
  const w = await world(t);
  const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await restartMac(t, w, v => ({ ...v, box: { ...v.box, assertKey: other } }));
  const { ask } = await macAsk(w);
  const r = await w.boxCall("threads.answer", { ask, decision: "allow" }, "deck");
  assert.equal(r.error.code, "denied");
  assert.match(r.error.message, /not signed by the box this Mac paired with/);
  assert.equal(answersRun(w).length, 0, "threads.answer never ran on the Mac");
  assert.equal((await w.macd.registry.call("threads.asks", {}, "capsule")).data.length, 1);
  await w.macd.registry.call("link.status", {}, "cli");
  assert.equal(saved(w).box.assertKey, other, "the heartbeat did not swap the pinned key");
});
