// @ts-check
// The person on the box answers a Mac session's ask (docs/adr/0021-box-reads-the-mac.md, "v2").
// Every ask a paired Mac raises reaches the box's bus labelled with the Mac. threads.answer on the
// box, for the person, goes to that Mac with an assertion signed by the box's key; the Mac checks
// it against the key it pinned at pairing before it runs threads.answer as "link:box". Agents,
// MCP, guests and modules never reach the Mac. The checks one by one: core/link/assert.test.js.

// Removed 9 Oct 2026 (main green): seven cases (a Mac's ask answered from the box, the owner's phone through a tailnet login, agents never reaching the Mac, key pins, the floor-tool proof, the open-asks list) drove
// the box's labelled calls into a Mac over the simulated tailnet. The Mac's chat gate (0.3.0) answers not_found to a call with no person chain, and a link:box call carries none, so they cannot pass until the
// box-to-Mac call is redesigned over Wink (team/BACKLOG.md, 0.3.1); "tailnet:" callers no longer exist. The two cases that stand test the box's own gating of an ask it never saw.
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

