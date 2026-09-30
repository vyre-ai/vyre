// @ts-check
// The report card (report.js) in the fake DOM: the three views, the row cap, status marks, actions
// that open a link or call a named tool, copy as text, and the error and empty states. Sample
// world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
const copied = [];
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { clipboard: { writeText: async t => { copied.push(t); } } } });

function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    calls.push({ tool, input: JSON.parse(o.body) });
    const a = tool in answers ? answers[tool] : { ok: true };
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 5)); };
const Ev = (type, o = {}) => Object.assign(new /** @type {any} */ (globalThis).Event(type), o);

const { report, reportText, statusOf, MAX_ROWS } = await import("./report.js");
const card = (d, ctx = {}) => report(d, { thread: "t-r", phone: true, ...ctx });

const DEVICES = Array.from({ length: 11 }, (_, i) => ({ name: `device-${i + 1}`, status: i === 1 ? "offline" : "online", seen: `${i + 1} min ago` }));

test("table: title, the command in mono, rows as list rows with a status mark and its word, eight then Show all", () => {
  const c = card({ kind: "report", title: "Devices", command: "vyre devices", rows: DEVICES.slice(0, 3) });
  assert.equal(c.getAttribute("aria-label"), "Devices");
  assert.match(text($(c, ".cv-rp-head")), /Devices\s*vyre devices/);
  assert.equal($(c, ".cv-rp-copy").getAttribute("aria-label"), "Copy as text");
  assert.equal($$(c, ".cv-rp-row").length, 3);
  assert.match(text($$(c, ".cv-rp-row")[1]), /device-2\s*offline · 2 min ago/);
  assert.equal($$(c, ".cv-rp-row")[1].querySelector(".cv-mark-failed") !== null, true);
  assert.equal($$(c, ".cv-rp-row")[0].querySelector(".cv-mark-done") !== null, true);
  assert.equal($(c, ".cv-rp-all"), null, "three rows need no Show all");
  const big = card({ title: "Devices", rows: DEVICES });
  assert.equal($$(big, ".cv-rp-row").length, MAX_ROWS);
  assert.match(text($(big, ".cv-rp-all")), /Show all 11/);
  $(big, ".cv-rp-all").click();
  assert.equal($$(big, ".cv-rp-row").length, 11);
  assert.equal($(big, ".cv-rp-all"), null);
  assert.match($(big, ".cv-rp-scroll").className, /tall/, "the opened list scrolls inside");
});

test("table: three or more named columns draw as a real table on the desktop, rows on a phone; empty uses its own words", () => {
  const rows = [{ name: "alex", plan: "Pro", seats: 4 }, { name: "juno", plan: "Team", seats: 12 }];
  const d = card({ title: "Accounts", rows }, { phone: false });
  assert.equal($$(d, "table th").length, 3);
  assert.equal($$(d, "th")[0].getAttribute("scope"), "col");
  assert.equal($$(d, "td")[2].className, "num");
  const st = card({ title: "Devices", rows: DEVICES.slice(0, 2) }, { phone: false });
  assert.equal($$(st, "table").length, 1);
  assert.match(text($$(st, "tr")[2]), /offline/);
  assert.ok($$(st, "tr")[2].querySelector(".cv-mark-failed"), "a status column draws its mark in the table too");
  const p = card({ title: "Accounts", rows });
  assert.equal($$(p, "table").length, 0);
  assert.equal($$(p, ".cv-rp-row").length, 2);
  const e = card({ title: "Devices", rows: [], empty: "No devices yet" });
  assert.match(text(e), /No devices yet/);
  assert.match(text(card({ title: "x", rows: [] })), /Nothing to show/);
});

test("text: paragraphs as prose, twelve lines then Show all; a fenced or code text is one code block", () => {
  const c = card({ title: "Summary", text: "First paragraph about the price list.\n\nSecond paragraph." });
  assert.equal($$(c, ".cv-rp-prose p").length, 2);
  assert.equal($(c, ".cv-rp-all"), null);
  const long = card({ view: "text", title: "Log", text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") });
  assert.match($(long, ".cv-rp-text").className, /clamp/);
  $(long, ".cv-rp-all").click();
  assert.doesNotMatch($(long, ".cv-rp-text").className, /clamp/);
  const code = card({ title: "Config", text: "```json\n{\"a\": 1}\n```" });
  assert.equal($$(code, "pre.cv-rp-code").length, 1);
  assert.equal(text($(code, ".cv-rp-code")), '{"a": 1}');
  const flagged = card({ title: "Config", text: "a=1\nb=2", code: true });
  assert.equal($$(flagged, "pre.cv-rp-code").length, 1);
});

test("card: the subject, then key and value rows from pairs, {label, value} rows or an object", () => {
  for (const rows of [[["Model", "Mac mini"], ["Version", "0.2.0"]], [{ label: "Model", value: "Mac mini" }, { label: "Version", value: "0.2.0" }], { Model: "Mac mini", Version: "0.2.0" }]) {
    const c = card({ view: "card", title: "Device", subject: "alex's Mac mini", rows });
    assert.equal(text($(c, ".cv-rp-subject")), "alex's Mac mini");
    assert.equal($$(c, ".cv-rp-fact").length, 2);
    assert.match(text($$(c, ".cv-rp-fact")[1]), /Version\s*0\.2\.0/);
  }
});

test("actions: at most three ghost buttons; a link opens through ctx.open, a tool goes through the outbox with the thread", async () => {
  const f = vyred();
  const opened = [];
  const c = card({ title: "Devices", rows: DEVICES.slice(0, 2), actions: [
    { label: "Open in Settings", href: "/settings#devices" },
    { label: "Refresh", key: "R", run: { tool: "devices.refresh", input: { scope: "all" } } },
    { label: "Pair a phone", run: { tool: "devices.pair", input: {} } },
    { label: "Fourth", run: { tool: "devices.nope", input: {} } },
    { label: "Broken" },
  ] }, { open: h => opened.push(h) });
  assert.deepEqual($$(c, ".cv-rp-act").map(b => text(b).replace(/R$/, "")), ["Open in Settings", "Refresh", "Pair a phone"]);
  assert.equal($$(c, ".cv-rp-act")[1].getAttribute("aria-keyshortcuts"), "R");
  $$(c, ".cv-rp-act")[0].click();
  assert.deepEqual(opened, ["/settings#devices"]);
  $$(c, ".cv-rp-act")[1].click();
  await settle();
  assert.deepEqual(f.of("devices.refresh")[0].input, { scope: "all", thread: "t-r" });
  assert.equal(f.of("devices.nope").length, 0);
  assert.equal(c.onKey(/** @type {any} */ ({ key: "r" })), true);
  await settle();
  assert.equal(f.of("devices.refresh").length, 2, "the key runs the same action");
});

test("actions: a failed tool says why with Retry; a script-made click does nothing", async () => {
  vyred({ "devices.refresh": { $error: { code: "x", message: "The Mac is asleep" } } });
  const c = card({ title: "Devices", rows: DEVICES.slice(0, 2), actions: [{ label: "Refresh", run: { tool: "devices.refresh" } }] });
  const f = vyred({ "devices.refresh": { $error: { code: "x", message: "The Mac is asleep" } } });
  $(c, ".cv-rp-act").dispatchEvent(Ev("click", { isTrusted: false }));
  await settle();
  assert.equal(f.calls.length, 0);
  $(c, ".cv-rp-act").click();
  await settle();
  assert.match(text($(c, ".cv-rp-error")), /The Mac is asleep/);
  assert.equal($(c, ".cv-rp-error").getAttribute("role"), "alert");
  const ok = vyred();
  $(c, "[data-act=retry]").click();
  await settle();
  assert.equal(ok.of("devices.refresh").length, 1);
  assert.equal($(c, ".cv-rp-error"), null);
});

test("copy as text: the header button copies the report as the CLI prints it, and reads Copied", async () => {
  const c = card({ title: "Devices", command: "vyre devices", rows: [["alex-mac", "online", "1 min ago"], ["juno-phone", "offline", "3 h ago"]] });
  $(c, ".cv-rp-copy").click();
  await settle();
  assert.deepEqual(copied, ["Devices\nalex-mac    online   1 min ago\njuno-phone  offline  3 h ago"]);
  assert.match(text($(c, ".cv-rp-copy")), /Copied/);
  assert.equal(reportText({ view: "text", title: "T", text: "body" }), "T\nbody");
  assert.equal(reportText({ view: "card", title: "T", rows: { A: "1" } }), "T\nA  1");
});

test("error and running: a failed report shows the plain words and the detail in mono; running swaps the icon for a spinner", () => {
  const e = card({ title: "Devices", error: { title: "Couldn't list devices", detail: "ECONNRESET after 15 s" } });
  assert.match(text($(e, ".cv-rp-error")), /Couldn't list devices/);
  assert.equal(text($(e, ".cv-rp-detail")), "ECONNRESET after 15 s");
  const j = card({ title: "Devices", error: '{"raw":"json"}' });
  assert.match(text($(j, ".cv-rp-error")), /That did not go through\./);
  const r = card({ title: "Devices", running: true, rows: [] });
  assert.ok($(r, ".cv-card-ico .cv-ask-spin"));
  r.update({ title: "Devices", rows: DEVICES.slice(0, 1) });
  assert.equal($(r, ".cv-card-ico .cv-ask-spin"), null);
  assert.equal($$(r, ".cv-rp-row").length, 1);
});

test("statusOf: words map to a mark, and an unknown word stays neutral", () => {
  assert.deepEqual(statusOf("online"), { state: "done", word: "online" });
  assert.deepEqual(statusOf("failed"), { state: "failed", word: "failed" });
  assert.deepEqual(statusOf("running"), { state: "running", word: "running" });
  assert.deepEqual(statusOf("paused"), { state: "neutral", word: "paused" });
});
