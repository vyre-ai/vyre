// @ts-check
// The person on the box types into a Mac's session (docs/adr/0021-box-reads-the-mac.md, "Sending
// to a Mac session"): threads.send for a thread the box does not have goes to the paired Mac as
// the person's, runs there as "link:box" (so a session busy in a terminal queues the words), and
// the thread's events come back to the box's bus through link.events, labelled with the Mac,
// until the answer is finished. Agents, MCP, guests and modules never reach the Mac.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER, MAC, wait, until, pair } from "./link-harness.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);

/** A box (harlow-box) and a Mac (alex-mac) with the Switchboard's fake claude, the Mac holding its request. */
async function world(t, opts = {}) {
  const env = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  process.env.VYRE_CLAUDE_BIN = FAKE;
  delete process.env.FAKE_CLAUDE_LOG;
  t.after(() => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const s = await pair(t, { macTranscripts: [], boxName: "harlow-box", macHost: "alex-mac", ...opts });
  await online(s);
  // Every tool the Mac's registry runs, to show what reached it.
  const ran = [];
  const real = s.mac.registry.call.bind(s.mac.registry);
  s.mac.registry.call = (tool, input, caller, meta) => { ran.push({ tool, input, caller }); return real(tool, input, caller, meta); };
  // Every event on the box's bus.
  const heard = [];
  const off = s.box.events.on("*", e => heard.push(e));
  t.after(off);
  return { ...s, ran, heard, transcripts: path.join(s.macRoot, "transcripts") };
}
const online = s => until(async () => { const m = (await s.boxCall("link.macs")).data; return m.length === 1 && m[0].online && m; });

/** A terminal session's transcript on the Mac, as Claude Code leaves one (as in the switchboard's tests). */
function terminalSession(transcripts, cwd, { ageMs = 120_000, id = crypto.randomUUID() } = {}) {
  const dir = path.join(transcripts, "-" + cwd.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, [
    { type: "user", cwd, sessionId: id, message: { role: "user", content: "start the Northwind order form" } },
    { type: "custom-title", customTitle: "Northwind orders", sessionId: id },
  ].map(l => JSON.stringify(l)).join("\n") + "\n");
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, when, when);
  return { id, file };
}

/** The box's events of one type for one thread, re-emitted from the Mac. */
const got = (s, thread, type) => s.heard.filter(e => e.thread === thread && e.type === type);
const macSends = s => s.ran.filter(r => r.tool === "threads.send");
const inbox = d => /** @type {any[]} */ (d.registry.deps.db.prepare("SELECT * FROM threads_inbox").all());
const macKey = s => JSON.parse(fs.readFileSync(path.join(s.macRoot, "link.json"), "utf8")).key;

test("federation send: the person on the box types into a free Mac session; the answer and the reply come back labelled with the Mac", async t => {
  const s = await world(t);
  const free = terminalSession(s.transcripts, s.macWork);
  const r = await s.boxCall("threads.send", { thread: free.id, text: "add a phone field", surface: "deck" }, "deck");
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual(r.data, { sent: true, thread: free.id, source: "mac", machine: "alex-mac" });

  // It ran on the Mac as the box, with the surface marked as the box's, and the Mac holds the lease for it.
  const [ran] = macSends(s);
  assert.deepEqual([ran.caller, ran.input.surface, ran.input.thread, ran.input.text], ["link:box", "box:deck", free.id, "add a phone field"]);
  assert.equal((await s.macCall("threads.get", { thread: free.id })).data.thread.holder, "box:deck");

  // The Mac's events for it arrive on the box's bus with the thread id, labelled with the Mac.
  const sent = await until(() => got(s, free.id, "thread.sent")[0]);
  assert.deepEqual([sent.payload.text, sent.payload.surface, sent.payload.source, sent.payload.machine, sent.project], ["add a phone field", "box:deck", "mac", "alex-mac", null]);
  const reply = await until(() => got(s, free.id, "thread.text").find(e => e.payload.done));
  assert.deepEqual([reply.payload.text, reply.payload.source, reply.payload.machine], ["echo: add a phone field", "mac", "alex-mac"]);
  const fin = await until(() => got(s, free.id, "thread.finished")[0]);
  assert.deepEqual([fin.payload.source, fin.payload.machine, fin.source], ["mac", "alex-mac", "link"]);
  assert.equal(s.box.registry.deps.db.prepare("SELECT COUNT(*) AS n FROM threads_runs").get().n, 0, "the box keeps no record of the Mac's thread");

  // The follow ends at thread.finished: the Mac's later words in that thread stay on the Mac.
  await until(async () => (await s.macCall("link.status")).data.following === 0);
  const before = got(s, free.id, "thread.text").length;
  assert.ok(!(await s.mac.registry.call("threads.notice", { thread: free.id, text: "Northwind's form is saved." }, "module:test")).error);
  await wait(700);
  assert.equal(got(s, free.id, "thread.text").length, before, "nothing more is forwarded after the answer finished");

  // machine names the Mac; a name no Mac has reaches none, and the box answers as usual.
  const again = await s.boxCall("threads.send", { thread: free.id, text: "and a note", machine: "alex-mac" }, "deck");
  assert.equal(again.data.source, "mac", JSON.stringify(again));
  const none = await s.boxCall("threads.send", { thread: free.id, text: "hi", machine: "kit-mac" }, "deck");
  assert.match(none.error.message, /^no thread/);
  assert.equal(macSends(s).length, 2);
});

test("federation send: a Mac session busy in a terminal queues the person's words, and the hand-over and the answer reach the box", async t => {
  const s = await world(t);
  const busy = terminalSession(s.transcripts, s.macWork, { ageMs: 1000 });
  const r = await s.boxCall("threads.send", { thread: busy.id, text: "which branch are you on?" }, "deck");
  assert.ok(!r.error, JSON.stringify(r.error));
  // queued_id (threads.unqueue's handle) is the Mac's row id; uuid (ADR 0030) the message's own id.
  const { queued_id, uuid, ...sent } = r.data;
  assert.ok(Number.isInteger(queued_id), "a queued_id to take the words back with");
  assert.match(uuid, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent, { sent: false, queued: true, open_elsewhere: true, thread: busy.id, name: "Northwind orders", busy: "terminal",
    note: "Northwind orders is busy in your terminal on alex-mac. I'll hand it your message when this turn ends.", source: "mac", machine: "alex-mac" });
  const queued = await until(() => got(s, busy.id, "thread.queued")[0]);
  assert.deepEqual([queued.payload.text, queued.payload.surface, queued.payload.machine], ["which branch are you on?", "box:deck", "alex-mac"]);
  assert.equal(inbox(s.mac).length, 1);
  assert.equal(inbox(s.box).length, 0, "nothing is queued on the box");

  // The terminal's turn ends: the Stop hook hands the words over, the way the Harness does.
  const stop1 = (await s.macCall("harness.stop", { session: busy.id, text: "Tests pass.", stop_hook_active: false }, "harness")).data;
  assert.equal(stop1.decision, "block");
  const handed = await until(() => got(s, busy.id, "thread.sent")[0]);
  assert.deepEqual([handed.payload.queued, handed.payload.via, handed.payload.text, handed.payload.source], [queued.payload.queued, "stop", "which branch are you on?", "mac"]);
  assert.equal(got(s, busy.id, "thread.finished").length, 0);

  // Claude answers in that session; its last message is the reply.
  assert.deepEqual((await s.macCall("harness.stop", { session: busy.id, text: "On main.", stop_hook_active: true }, "harness")).data, { ok: true });
  const reply = await until(() => got(s, busy.id, "thread.text")[0]);
  assert.deepEqual([reply.payload.text, reply.payload.done, reply.payload.machine], ["On main.", true, "alex-mac"]);
  await until(() => got(s, busy.id, "thread.finished")[0]);
  await until(async () => (await s.macCall("link.status")).data.following === 0);
});

test("federation send: a Mac session another surface holds queues the box's words and never takes the keyboard", async t => {
  const s = await world(t);
  const free = terminalSession(s.transcripts, s.macWork);
  assert.equal((await s.boxCall("threads.send", { thread: free.id, text: "add a phone field" }, "deck")).data.sent, true);
  await until(() => got(s, free.id, "thread.finished")[0]);
  // The Capsule on the Mac takes the keyboard; the person at the box types again.
  assert.equal((await s.macCall("threads.lease", { thread: free.id, surface: "capsule" }, "capsule")).data.holder, "capsule");
  const r = await s.boxCall("threads.send", { thread: free.id, text: "and a note field" }, "deck");
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.deepEqual([r.data.sent, r.data.queued, r.data.busy, r.data.machine], [false, true, "capsule", "alex-mac"]);
  assert.equal(r.data.note, "Northwind orders is in use in capsule on alex-mac. I'll hand it your message when this turn ends.");
  assert.equal((await s.macCall("threads.get", { thread: free.id })).data.thread.holder, "capsule", "the Capsule keeps the keyboard");
  assert.deepEqual(inbox(s.mac).map(m => [m.text, m.surface]), [["and a note field", "box:deck"]]);
  // A surface the input names is still the box's, on the Mac.
  await s.boxCall("threads.send", { thread: free.id, text: "one more", surface: "capsule" }, "deck");
  assert.equal(inbox(s.mac).at(-1).surface, "box:capsule");
});

test("federation send: a thread.finished while queued words wait is not the end of the follow", async t => {
  const s = await world(t);
  const busy = terminalSession(s.transcripts, s.macWork, { ageMs: 1000 });
  // Words handed over earlier from the Mac itself, not answered yet.
  assert.ok((await s.macCall("threads.send", { thread: busy.id, text: "run the tests" }, "capsule")).data.queued);
  await s.macCall("harness.stop", { session: busy.id, text: "Working.", stop_hook_active: false }, "harness");
  // Now the person on the box sends. The next Stop ends the turn that answered the earlier words
  // (thread.finished) and, in the same hook, hands the box's words over.
  assert.equal((await s.boxCall("threads.send", { thread: busy.id, text: "then deploy" }, "deck")).data.queued, true);
  assert.equal((await s.macCall("harness.stop", { session: busy.id, text: "Tests pass.", stop_hook_active: true }, "harness")).data.decision, "block");
  await until(() => got(s, busy.id, "thread.sent").find(e => e.payload.text === "then deploy"));
  const first = got(s, busy.id, "thread.finished");
  assert.equal(first.length, 1, "the earlier words' answer finished while the box's were waiting");
  assert.equal(got(s, busy.id, "thread.text")[0].payload.text, "Tests pass.");
  assert.equal((await s.macCall("link.status")).data.following, 1, "that finish did not end the follow");
  // The box's words are answered: that finish ends it.
  assert.deepEqual((await s.macCall("harness.stop", { session: busy.id, text: "Deployed.", stop_hook_active: true }, "harness")).data, { ok: true });
  await until(() => got(s, busy.id, "thread.text").find(e => e.payload.text === "Deployed."));
  await until(() => got(s, busy.id, "thread.finished").length === 2);
  await until(async () => (await s.macCall("link.status")).data.following === 0);
});

test("federation send: agents, MCP, guests and modules never reach the Mac; they get the box's own answer", async t => {
  const s = await world(t);
  const free = terminalSession(s.transcripts, s.macWork);
  for (const caller of ["mcp", "mcp:agent:kit", "harness:agent:juno", "tailnet-guest:sam@harlow.example", "tailnet:agent:kit", "module:test", "unknown"]) {
    const r = await s.boxCall("threads.send", { thread: free.id, text: "hi", machine: "alex-mac" }, caller);
    assert.ok(r.error, `${caller}: ${JSON.stringify(r.data)}`);
    assert.match(r.error.message, /^no thread|only the assistant/, caller);
  }
  assert.deepEqual(macSends(s), [], "the Mac's registry saw no threads.send");
  assert.equal(inbox(s.mac).length, 0);

  // link.macs.call with a write and no `as: "person"` is refused before anything is queued.
  for (const extra of [{}, { as: "agent" }, { as: "Person" }]) {
    const r = await s.box.registry.call("link.macs.call", { tool: "threads.send", input: { thread: free.id, text: "hi" }, ...extra }, "module:test");
    assert.equal(r.error && r.error.code, "denied", JSON.stringify(extra));
  }
  assert.deepEqual(macSends(s), []);
  assert.equal((await s.box.registry.call("link.macs.call", { tool: "threads.list" }, "module:test")).data[0].ok, true, "nothing was left queued");
});

test("federation send: a box that sends a write without `as` is refused by the Mac", async t => {
  // The box's read list is widened for this test only, so the write goes out as a read.
  const s = await world(t, { allow: ["threads.send", "threads.list"] });
  const free = terminalSession(s.transcripts, s.macWork);
  const [r] = (await s.box.registry.call("link.macs.call", { tool: "threads.send", input: { thread: free.id, text: "hi" } }, "module:test")).data;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "denied");
  assert.match(r.error.message, /only for the person/);
  assert.deepEqual(macSends(s), []);
  assert.equal((await s.box.registry.call("link.macs.call", { tool: "threads.list" }, "module:test")).data[0].ok, true, "the loop carries on");
});

test("federation send: link.events from another key, for a thread never sent to, or of another type is dropped", async t => {
  const s = await world(t);
  const free = terminalSession(s.transcripts, s.macWork);
  assert.equal((await s.boxCall("threads.send", { thread: free.id, text: "hello" }, "deck")).data.sent, true);
  await until(() => got(s, free.id, "thread.finished")[0]);
  const asMac = (input, peer = MAC) => s.boxCall("link.events", input, `tailnet:${OWNER}`, { peer });
  const ev = (type, thread = free.id) => ({ type, thread, project: null, at: Date.now(), payload: { text: "from nowhere", done: true } });
  const count = () => s.heard.filter(e => e.payload && e.payload.text === "from nowhere").length;

  assert.deepEqual((await asMac({ key: "not-the-key", events: [ev("thread.text")] })).data, { paired: false });
  assert.deepEqual((await asMac({ key: macKey(s), events: [ev("thread.text")] }, { login: OWNER, node: "test-phone", stableId: "nPHONE" })).data, { paired: false }, "the Mac's key from another node");
  assert.equal((await asMac({ key: macKey(s), events: [ev("thread.text", crypto.randomUUID())] })).data.taken, 0, "a thread the box never sent to");
  for (const type of ["ask.raised", "thread.tool", "thread.watched", "link.paired", "nonsense"]) {
    assert.equal((await asMac({ key: macKey(s), events: [ev(type)] })).data.taken, 0, type);
  }
  // One that looks like a secret is dropped alone; the rest of the batch is taken.
  const secret = { ...ev("thread.text"), payload: { text: "from nowhere sk-" + "a".repeat(30) } };
  assert.equal((await asMac({ key: macKey(s), events: [secret, ev("thread.text")] })).data.taken, 1);
  assert.equal(count(), 1);
});

test("federation send: an offline Mac answers at once that the message was not sent, and nothing is queued", async t => {
  const s = await world(t);
  const free = terminalSession(s.transcripts, s.macWork);
  await s.stopTailnet();
  await until(async () => { const r = (await s.box.registry.call("link.macs.call", { tool: "threads.list", timeout: 100 }, "module:test")).data[0]; return r.error && r.error.code === "mac_offline"; });
  const t0 = Date.now();
  const r = await s.boxCall("threads.send", { thread: free.id, text: "are you there?" }, "deck");
  assert.ok(Date.now() - t0 < 2000, `answered in ${Date.now() - t0} ms`);
  assert.deepEqual(r.error, { code: "mac_offline", message: "alex-mac is offline; your message was not sent" });
  // The Mac comes back: nothing was waiting for it, and nothing is queued on either machine.
  await s.startTailnet();
  // link.macs counts a Mac seen in the last hold plus 5 s as online; a read waits for it to serve again.
  await until(async () => (await s.box.registry.call("link.macs.call", { tool: "threads.list" }, "module:test")).data[0].ok);
  assert.deepEqual(macSends(s), []);
  assert.equal(inbox(s.mac).length + inbox(s.box).length, 0);
  assert.equal((await s.macCall("link.status")).data.following, 0);
});
