// @ts-check
// The person on the box answers a Mac session's ask (docs/adr/0021-box-reads-the-mac.md, "v2").
// Every ask a paired Mac raises reaches the box's bus labelled with the Mac. threads.answer on the
// box, for the person, goes to that Mac with an assertion signed by the box's key; the Mac checks
// it against the key it pinned at pairing before it runs threads.answer as "link:box". Agents,
// MCP, guests and modules never reach the Mac. The checks one by one: core/link/assert.test.js.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { KEY_FILE } from "../core/link/assert.js";
import { Presence } from "../core/presence/index.js";
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
  // What the box's switchboard asks of the link: a refused answer must not even be signed.
  const linked = [];
  const real = s.box.registry.call.bind(s.box.registry);
  s.box.registry.call = (tool, input, caller, meta) => { if (tool === "link.macs.call") linked.push(input); return real(tool, input, caller, meta); };
  const w = { ...s, heard, linked, ran: /** @type {any[]} */ ([]), macd: s.mac };
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
async function macAsk(w, command = "ls", prompt = `bash ${command}`) {
  const started = await w.macd.registry.call("threads.start", { cwd: w.macWork, prompt, surface: "capsule" }, "capsule");
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
  // The box keeps no ask of the Mac's, but lists the Mac's open ones for the person (a reconnect).
  const listed = (await w.boxCall("threads.asks", {}, "deck")).data;
  assert.deepEqual(listed.map(a => [a.id, a.source, a.machine, a.presence.required]), [[ask, "mac", "alex-mac", false]]);

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

  // An ask the box never saw counts as gated (it could approve anything, and after a restart the
  // box would not know either way, e2e review of 0f2a8752, LOW 1), so it takes a fresh proof.
  const unproved = await w.boxCall("threads.answer", { ask: "zzzzzzzzzzzzzzzzzz", decision: "deny", machine: "alex-mac" }, "deck");
  assert.equal(unproved.error.code, "presence_required");
  // With a fresh proof it is forwarded, but the Mac does not have it either: it fails closed
  // rather than guess whether it was gated (e2e review of 0f2a8752, MEDIUM), so the Mac's own
  // "no ask zzzz" from the switchboard is never reached.
  const gone = await w.boxCall("threads.answer", { ask: "zzzzzzzzzzzzzzzzzz", decision: "deny", machine: "alex-mac" }, "deck", { presence: { method: "passkey", keyId: null } });
  assert.match(gone.error.message, /could not read this ask/);
  assert.equal(answersRun(w).length, 1);
  // An ask no Mac raised and no machine named is unknown too, so it is gated the same way: a
  // fresh proof is needed before the box even tries a Mac.
  const none = await w.boxCall("threads.answer", { ask: "yyyyyyyyyyyyyyyyyy", decision: "deny" }, "deck");
  assert.equal(none.error.code, "presence_required");
  assert.equal(answersRun(w).length, 1);
});

test("federation answer: the owner's phone answers only inside a person session, the device and the person in what the box signs", async t => {
  const w = await world(t);
  const { ask } = await macAsk(w, "npm test");
  const phone = { peer: { stableId: "nPHONE", node: "test-phone", login: "owner@example.com" } };
  // A device without a person session: refused on the box, nothing signed, nothing sent.
  const bare = await w.boxCall("threads.answer", { ask, decision: "deny" }, "tailnet:owner@example.com", phone);
  assert.equal(bare.error.code, "person_session_required");
  assert.deepEqual([w.linked.length, answersRun(w).length], [0, 0], "no assertion was made, and the Mac saw nothing");
  // In a person session, an ungated ask takes no proof (the no-nag rule).
  const r = await w.boxCall("threads.answer", { ask, decision: "deny", message: "not now" }, "tailnet:owner@example.com", { ...phone, person: { id: "ps-alex-phone", kind: "passkey" } });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual(w.linked[0].by, { caller: "tailnet:owner@example.com", device: "nPHONE", person: "ps-alex-phone" });
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

test("federation answer: an ask that approves a floor tool needs a fresh proof on the box, and the Mac checks it too", async t => {
  const w = await world(t);
  const { ask, raised } = await macAsk(w, "", "use mcp__vyre__vault_reveal");
  assert.equal(raised.payload.tool, "mcp__vyre__vault_reveal");
  // threads.answer's rule on the box asks for presence for this input only, as the floor reads it.
  const def = w.box.registry.tools.get("threads.answer");
  assert.equal(Presence.prototype.required.call({}, "threads.answer", def, { ask, decision: "allow" }), true);
  assert.equal(Presence.prototype.required.call({}, "threads.answer", w.macd.registry.tools.get("threads.answer"), { ask, decision: "allow" }), false, "the Mac declares no rule");

  // Refused without a proof, and with a presence session: nothing is signed.
  for (const meta of [{}, { presence: { method: "session", keyId: null } }]) {
    const r = await w.boxCall("threads.answer", { ask, decision: "allow" }, "deck", meta);
    assert.equal(r.error && r.error.code, "presence_required", JSON.stringify(meta));
  }
  assert.equal(w.linked.length, 0);

  // Signed by the box without a fresh proof (as a changed box would), the Mac still refuses.
  for (const presence of [undefined, "session"]) {
    const r = await w.boxCall("link.macs.call", { tool: "threads.answer", as: "person", by: { caller: "deck", ...(presence ? { presence } : {}) }, input: { ask, decision: "allow", surface: "deck" } }, "module:test");
    assert.equal(r.data[0].ok, false);
    assert.equal(r.data[0].error.code, "denied");
    assert.match(r.data[0].error.message, /fresh proof of presence/);
  }
  assert.equal(answersRun(w).length, 0, "threads.answer never ran on the Mac");

  // A fresh proof: forwarded, and answered.
  const ok = await w.boxCall("threads.answer", { ask, decision: "allow" }, "deck", { presence: { method: "passkey", keyId: "k1" } });
  assert.ok(!ok.error, JSON.stringify(ok.error));
  assert.deepEqual([ok.data.answered, ok.data.machine], [true, "alex-mac"]);
  assert.equal(w.linked.at(-1).by.presence, "passkey");
});

test("federation answer: the Mac fails closed when it cannot read its own ask, even for a plain ask (e2e review of 0f2a8752, MEDIUM)", async t => {
  const w = await world(t);
  const { ask } = await macAsk(w, "ls"); // plain, ungated: the box asks for no proof at all
  const real = w.macd.registry.call.bind(w.macd.registry);
  // threads.asks fails on the Mac: gatedAsk(null) would say "ungated", so without this fix the
  // assertion (carrying no fresh proof, since the box never asked for one) would be accepted.
  w.macd.registry.call = (tool, input, caller, meta) => tool === "threads.asks"
    ? Promise.resolve({ error: { code: "failed", message: "boom" } }) : real(tool, input, caller, meta);
  const r = await w.boxCall("threads.answer", { ask, decision: "allow" }, "deck");
  assert.equal(r.error?.code, "denied");
  assert.match(r.error?.message || "", /could not read this ask/);
  assert.equal(answersRun(w).length, 0, "threads.answer never ran on the Mac");
  w.macd.registry.call = real;

  // Not found in threads.asks either (the box names a machine for an ask it never saw): the box
  // itself treats an unknown ask as gated (LOW 1, below), so it asks for a fresh proof first.
  const unproved = await w.boxCall("threads.answer", { ask: "no-such-ask", decision: "allow", machine: "alex-mac" }, "deck");
  assert.equal(unproved.error?.code, "presence_required");
  const s = await w.boxCall("threads.answer", { ask: "no-such-ask", decision: "allow", machine: "alex-mac" }, "deck", { presence: { method: "passkey", keyId: null } });
  assert.equal(s.error?.code, "denied");
  assert.match(s.error?.message || "", /could not read this ask/);
});

test("federation answer: an unknown ask on the box (no machine named) is treated as gated, not ungated (e2e review of 0f2a8752, LOW 1)", async t => {
  const w = await world(t);
  // The box never saw this ask raised (as after a restart: macAsks is memory-only), and no
  // `machine` names where it is: gatedOnMac must say "gated" rather than let it through free.
  const def = w.box.registry.tools.get("threads.answer");
  assert.equal(Presence.prototype.required.call({}, "threads.answer", def, { ask: "unseen-ask", decision: "allow" }), true);
});

test("federation answer: threads.asks on the box lists the Macs' open asks for the person only, gated ones asking a fresh proof", async t => {
  const w = await world(t);
  const plain = await macAsk(w, "ls");
  const gated = await macAsk(w, "", "use mcp__vyre__vault_reveal");
  const rows = (await w.boxCall("threads.asks", {}, "deck")).data;
  assert.deepEqual(rows.map(a => [a.id, a.source, a.machine, a.presence.required]),
    [[plain.ask, "mac", "alex-mac", false], [gated.ask, "mac", "alex-mac", true]], "oldest first, labelled");
  assert.ok(rows.every(a => !("request_id" in a)));
  // kind filters on the Mac too, and machines: "local" is the box's own list only.
  assert.equal((await w.boxCall("threads.asks", { kind: "question" }, "deck")).data.length, 0);
  assert.equal((await w.boxCall("threads.asks", { machines: "local" }, "deck")).data.length, 0);
  // An agent, MCP or a module (without machines: "all") gets the box's own list, and no Mac is asked.
  const before = w.ran.filter(r => r.tool === "threads.asks").length;
  for (const caller of ["mcp", "module:test"]) {
    const r = await w.boxCall("threads.asks", {}, caller);
    assert.ok(r.error || r.data.length === 0, caller);
  }
  assert.equal(w.ran.filter(r => r.tool === "threads.asks").length, before, "the Mac was never asked");
  // Listing taught the box which asks are gated: the listed gated ask needs a proof, the plain one none.
  const def = w.box.registry.tools.get("threads.answer");
  assert.equal(Presence.prototype.required.call({}, "threads.answer", def, { ask: gated.ask, decision: "allow" }), true);
  assert.equal(Presence.prototype.required.call({}, "threads.answer", def, { ask: plain.ask, decision: "allow" }), false);
  const ok = await w.boxCall("threads.answer", { ask: plain.ask, decision: "deny", machine: "alex-mac" }, "deck");
  assert.ok(!ok.error, JSON.stringify(ok.error));
});
