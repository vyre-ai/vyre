// @ts-check
// A session on the paired Mac, in the fake DOM with a fake box and event stream: it has a
// composer whose sends carry the machine, the lease line says where it is and what is queued (no
// Take), an offline Mac keeps the words and says so, cards answer with the machine (and fall back to
// "Answer it on" when the box cannot forward it), and the reply's
// live rows give way to the Mac's blocks (recall.transcript, source "mac") so nothing shows twice. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.addEventListener = () => {}; doc.removeEventListener = () => {};
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {},
  localStorage: { getItem: () => null, setItem: () => {} },
});
const El = /** @type {any} */ (globalThis).Element;
const E = El.prototype;
const sibs = n => (n.parentNode ? n.parentNode.childNodes : []);
Object.defineProperties(E, {
  previousElementSibling: { get() { const s = sibs(this); for (let i = s.indexOf(this) - 1; i >= 0; i--) if (s[i] instanceof El) return s[i]; return null; } },
  nextElementSibling: { get() { const s = sibs(this); for (let i = s.indexOf(this) + 1; i < s.length; i++) if (s[i] instanceof El) return s[i]; return null; } },
  nextSibling: { get() { const s = sibs(this); return s[s.indexOf(this) + 1] || null; } },
  lastElementChild: { get() { const c = this.children; return c[c.length - 1] || null; } },
});
E.insertBefore = function (n, ref) { if (!ref) { this.append(n); return n; } n.remove(); this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); n.parentNode = this; return n; };
E.replaceWith = function (n) { const p = this.parentNode; if (!p) return; p.insertBefore(n, this); this.remove(); };

// The event stream, fed by hand: api.js hear() hands an event to the listeners as the stream does.
let evId = 0;
const { hear } = await import("../js/api.js");
const MAC = "7c1d2e3f-mac-session";
const emit = (type, payload) => hear(/** @type {any} */ ({ id: ++evId, type, thread: MAC, project: null, at: Date.now(), payload: { thread: MAC, source: "mac", machine: "alex-mac", ...payload } }));

const T0 = Date.now() - 60_000;
const turns = [
  { seq: 0, role: "user", ts: T0, text: "Open the Northwind Bakery order form" },
  { seq: 1, role: "assistant", ts: T0 + 1000, text: "It is open." },
  { seq: 2, role: "user", ts: T0 + 2000, text: "Check the pickup dates" },
  { seq: 3, role: "assistant", ts: T0 + 3000, text: "Pickup dates are fine." },
  { seq: 4, role: "user", ts: T0 + 4000, text: "And the Saturday slots" },
  { seq: 5, role: "assistant", ts: T0 + 5000, text: "Saturday slots are in." },
];
let have = 2;
/** @type {any} */ let answerErr = null;
const calls = [];
/** @type {any[]} */ const sends = [];
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  const input = JSON.parse(o.body);
  calls.push({ tool, input });
  const ok = data => ({ status: 200, statusText: "", json: async () => ({ data }) });
  if (tool === "recall.transcript") {
    // The box reads the Mac's session as blocks through the link (source "mac"). Reply ids are the
    // ones the live thread.text events carry (m1, m2), as Claude Code's message ids are.
    const blocks = input.before != null ? [] : turns.slice(0, have).filter(t => t.seq >= (input.from || 0))
      .map(t => t.role === "user" ? { seq: t.seq, kind: "user", ts: t.ts, text: t.text } : { seq: t.seq, kind: "text", ts: t.ts, message: "m" + (t.seq - 1) / 2, text: t.text });
    return ok({ session: { id: MAC, cwd: "/Users/alex/work/northwind-bakery", name: "northwind" }, source: "mac", machine: "alex-mac", blocks, next: have, first: 0 });
  }
  if (tool === "recall.thread") {
    const from = input.from || 0;
    return ok({ session: { id: MAC, cwd: "/Users/alex/work/northwind-bakery", name: "northwind" }, source: "mac", machine: "alex-mac", turns: turns.slice(from, have) });
  }
  if (tool === "threads.send") {
    const a = sends.shift();
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return ok(a);
  }
  if (tool === "threads.continue-here") return ok({ thread: "box-copy-1" });
  if (tool === "system.info") return ok({ assistant: { name: "juno" }, owner: { name: "alex" } });
  if (tool === "threads.asks") return ok([]);
  if (tool === "threads.answer" && answerErr) return { status: 409, statusText: "", json: async () => ({ error: answerErr }) };
  return ok({});
});
const wait = (ms = 15) => new Promise(r => setTimeout(r, ms));

const { mountSession } = await import("./session.js");
const box = new El("div");
doc.body.append(box);
mountSession(box, { thread: MAC, project: null, recorded: true, known: true, turns: 2, source: "mac", machine: "alex-mac", onBack() {} });
await wait();
const ta = () => /** @type {any} */ ($(box, "textarea"));
const type = async (words) => { ta().value = words; const e = /** @type {any} */ (new Event("keydown")); e.key = "Enter"; e.target = ta(); ta().dispatchEvent(e); await wait(); };
const count = (s) => text($(box, ".thread-view")).split(s).length - 1;

test("a Mac session opens with a composer, the machine chip, 'On alex-mac' and no Take", () => {
  assert.ok(ta(), "a composer");
  assert.ok($(box, ".tag.machine"));
  assert.match(text($(box, ".lease-bar")).trim(), /^On alex-mac$/);
  assert.equal($$(box, ".lease-bar button").length, 0, "no Take");
  assert.equal(count("It is open."), 1);
  const read = calls.find(c => c.tool === "recall.transcript");
  assert.ok(read && read.input.source === "mac" && read.input.limit === 80, "blocks from the Mac, in small pages");
  assert.ok(!calls.some(c => c.tool === "recall.thread" || c.tool === "threads.get"), "no older turn view, no thread on your server");
});

test("a send carries the machine; the reply's live rows give way to the Mac's turns, once each", async () => {
  sends.push({ sent: true, thread: MAC, source: "mac", machine: "alex-mac" });
  await type("Check the pickup dates");
  const c = calls.filter(x => x.tool === "threads.send").at(-1);
  assert.deepEqual(c.input, { thread: MAC, text: "Check the pickup dates", surface: "deck", machine: "alex-mac" });
  assert.equal(calls.filter(x => x.tool === "threads.lease").length, 0, "the lease is not forwarded, so none is asked for");
  emit("thread.sent", { text: "Check the pickup dates", surface: "box:deck" });
  emit("thread.text", { message: "m1", text: "Pickup dates are fine.", done: true });
  assert.equal(count("Pickup dates are fine."), 1, "drawn live");
  have = 4;
  emit("thread.finished", { ok: true });
  await wait();
  assert.equal(count("Check the pickup dates"), 1);
  assert.equal(count("Pickup dates are fine."), 1);
  assert.ok(calls.some(x => x.tool === "recall.transcript" && x.input.from === 2 && x.input.source === "mac"), "re-read from the last block held");
  assert.doesNotMatch(text($(box, ".thread-view")), /box:deck/);
});

test("queued on a busy Mac: the lease line says so, the message shows once as yours when handed over", async () => {
  sends.push({ sent: false, queued: true, open_elsewhere: true, thread: MAC, name: "northwind", note: "Queued until the session in the terminal finishes its turn.", source: "mac", machine: "alex-mac" });
  await type("And the Saturday slots");
  assert.match(text($(box, ".composer-note")), /On alex-mac · Queued until/);
  emit("thread.queued", { queued: "inbox-1", text: "And the Saturday slots", surface: "box:deck" });
  assert.match(text($(box, ".lease-bar")), /On alex-mac · Queued for northwind/);
  assert.equal(count("And the Saturday slots"), 0, "waiting is not in the timeline");
  have = 5; // handed over: the Mac's transcript has the message, not yet the reply
  emit("thread.sent", { text: "And the Saturday slots", surface: "box:deck", queued: "inbox-1", via: "prompt" });
  await wait();
  emit("thread.text", { message: "m2", text: "Saturday slots are in.", done: true });
  have = 6;
  emit("thread.finished", { ok: true });
  await wait();
  assert.equal(count("And the Saturday slots"), 1);
  assert.equal(count("Saturday slots are in."), 1);
  assert.match(text($(box, ".lease-bar")).trim(), /^On alex-mac$/);
});

test("an offline Mac keeps the words, says so, offers Try again and chips the header", async () => {
  sends.push({ $error: { code: "mac_offline", message: "alex-mac is offline; your message was not sent" } });
  await type("Are you there?");
  assert.equal(ta().value, "Are you there?");
  assert.match(text($(box, ".composer-note")), /alex-mac is offline; your message was not sent/);
  assert.ok($$(box, ".composer-retry").length);
  assert.match(text($(box, ".session-head")), /alex-mac offline/);
  sends.push({ $error: { code: "timeout", message: "northwind did not answer in time; your message may not have been sent" } });
  await type("Are you there?");
  assert.equal(ta().value, "Are you there?");
  assert.match(text($(box, ".composer-note")), /It may have been sent\. Check before sending again\./);
  sends.push({ sent: true, thread: MAC, source: "mac", machine: "alex-mac" });
  await type("Are you there?");
  assert.doesNotMatch(text($(box, ".session-head")), /offline/, "a send that went through clears the chip");
});

test("the Mac goes to sleep: the line says so, 'Continue on the server' appears and opens your server's copy; waking brings the line back", async () => {
  const went = /** @type {string[]} */ ([]);
  Object.defineProperty(globalThis, "history", { value: { state: null, pushState: (/** @type {any} */ _s, /** @type {any} */ _t, /** @type {string} */ u) => went.push(u), replaceState() {} }, configurable: true, writable: true });
  assert.equal($$(box, "[data-act=continue-here]").length, 0, "nothing while the Mac is awake");
  hear(/** @type {any} */ ({ id: ++evId, type: "link.mac-offline", thread: null, project: null, at: Date.now(), payload: { mac: "m1", name: "alex-mac", why: "sleep" } }));
  await wait();
  assert.match(text($(box, ".lease-bar")), /alex-mac is asleep or offline/);
  const btn = $(box, "[data-act=continue-here]");
  assert.ok(btn, "the way out");
  await btn.click(); await wait();
  assert.deepEqual(calls.filter(c => c.tool === "threads.continue-here").map(c => c.input), [{ thread: MAC, machine: "alex-mac" }]);
  assert.deepEqual(went, ["/chat/thread/box-copy-1"]);
  hear(/** @type {any} */ ({ id: ++evId, type: "link.mac-online", thread: null, project: null, at: Date.now(), payload: { mac: "m1", name: "alex-mac" } }));
  await wait();
  assert.match(text($(box, ".lease-bar")).trim(), /^On alex-mac$/);
  assert.equal($$(box, "[data-act=continue-here]").length, 0);
});

test("cards on a Mac session: the usual buttons, 'on alex-mac', and the answer carries the machine", async () => {
  emit("ask.raised", { ask: "ask_m1", kind: "permission", tool: "Bash", summary: "npm run deploy", node: "nMacStable1" });
  emit("ask.raised", { ask: "ask_m2", kind: "question", tool: "AskUserQuestion", node: "nMacStable1", questions: [{ question: "Which slots?", header: "Slots", options: [{ label: "Mornings" }, { label: "All day" }] }] });
  await wait();
  const ask = $(box, ".cv-ask"), q = $(box, ".cv-q");
  for (const c of [ask, q]) {
    assert.match(text(c), /on alex-mac/);
    assert.doesNotMatch(text(c), /Answer it on/);
    assert.ok($$(c, "button").length > 0);
    assert.equal(c.isOpen(), true);
  }
  await $$(ask, "button").find(b => /Allow once/.test(text(b))).click();
  await wait();
  const c = calls.filter(x => x.tool === "threads.answer").at(-1);
  assert.deepEqual(c.input, { ask: "ask_m1", decision: "allow", surface: "deck", machine: "alex-mac" });
  assert.match(text(ask), /Allowed once/);
});

// Last: the fallback is remembered for the page.
test("a server that cannot forward the answer: the card falls back to 'Answer it on alex-mac', and so do later ones", async () => {
  answerErr = { code: "bad_input", message: "machine: not allowed" };
  const q = $(box, ".cv-q");
  await $$(q, "button").find(b => text(b) === "Decline").click();
  await wait();
  assert.equal(calls.filter(x => x.tool === "threads.answer").at(-1).input.machine, "alex-mac");
  assert.match(text(q), /Answer it on alex-mac/);
  assert.equal($$(q, "button").length, 0);
  assert.equal(q.isOpen(), false);
  // The page remembers it: a later Mac ask says where to answer from the start.
  emit("ask.raised", { ask: "ask_m3", kind: "permission", tool: "Bash", summary: "npm test" });
  await wait();
  const later = $$(box, ".cv-ask").at(-1);
  assert.match(text(later), /Answer it on alex-mac/);
  assert.equal($$(later, "button").length, 0);
});
