// @ts-check
// Chat's tip on the composer hint line (tip-line.js) in the fake DOM with a fake vyred: what it
// asks, when it hides, and what Show me, the × and "Hide tips about this" call. Sample world only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; return { documentElement: new E("svg") }; } },
});

function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input });
    const a = typeof answers[tool] === "function" ? answers[tool](input) : answers[tool];
    return { status: 200, statusText: "", json: async () => ({ data: a ?? { ok: true } }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 5));
const { mountTip, tipPieces, docsUrl } = await import("./tip-line.js");
const TIP = { id: "chat/queue", module: "chat", text: "Press `⌥⏎` to queue a message for after this turn.", key: "⌥⏎" };

test("tipPieces: the tip's key is a key chip, any other backticked part is code", () => {
  assert.deepEqual(tipPieces("Press `⌥⏎` to queue, or type `!ls`.", "⌥⏎"),
    [{ kind: "text", text: "Press " }, { kind: "key", text: "⌥⏎" }, { kind: "text", text: " to queue, or type " }, { kind: "code", text: "!ls" }, { kind: "text", text: "." }]);
  assert.equal(docsUrl("using/chat.md#queue"), "https://docs.vyre.run/using/chat#queue");
  assert.equal(docsUrl("index.md"), "https://docs.vyre.run/");
  assert.equal(docsUrl("using/index.md"), "https://docs.vyre.run/using/");
  assert.equal(docsUrl("using/index.md#start"), "https://docs.vyre.run/using/#start");
  assert.equal(docsUrl("/build/tips.md"), "https://docs.vyre.run/build/tips");
});

test("tip: asked once on open with the module, drawn with its key, seen; hidden while busy or typing", async () => {
  const f = vyred({ "tips.next": { tip: TIP } });
  const slot = /** @type {any} */ (document.createElement("div"));
  const st = { busy: false, text: "" };
  const t = mountTip(slot, { busy: () => st.busy, empty: () => !st.text, visible: () => true });
  await settle();
  assert.deepEqual(f.of("tips.used").map(c => c.input), [{ module: "chat" }]);
  assert.deepEqual(f.of("tips.next").map(c => c.input), [{ surface: "chat", context: { module: "chat", idle: false, busy: false } }]);
  assert.equal(slot.hidden, false);
  assert.match(text(slot), /Press ⌥⏎ to queue a message for after this turn\./);
  assert.ok($(slot, ".cv-tip-key"), "the key as a chip");
  assert.equal($(slot, ".cv-tip").getAttribute("role"), "note");
  assert.deepEqual(f.of("tips.seen").map(c => c.input), [{ id: "chat/queue", surface: "chat" }]);
  st.busy = true; t.sync();
  assert.equal(slot.hidden, true, "a running turn hides it at once");
  st.busy = false; st.text = "Add the"; t.sync();
  assert.equal(slot.hidden, true, "typing hides it");
  st.text = ""; t.sync();
  assert.equal(slot.hidden, false, "back when the composer is empty and nothing runs");
  t.stop();
});

test("tip: the × dismisses it, a right click hides tips about the module; nothing when tips.next has none", async () => {
  const f = vyred({ "tips.next": { tip: TIP } });
  const slot = /** @type {any} */ (document.createElement("div"));
  const t = mountTip(slot, { busy: () => false, empty: () => true, visible: () => true });
  await settle();
  $(slot, ".cv-tip-x").click();
  assert.equal(slot.hidden, true);
  assert.deepEqual(f.of("tips.dismiss").map(c => c.input), [{ id: "chat/queue" }]);
  t.stop();
  const g = vyred({ "tips.next": { tip: TIP } });
  const s2 = /** @type {any} */ (document.createElement("div"));
  const t2 = mountTip(s2, { busy: () => false, empty: () => true, visible: () => true });
  await settle();
  $(s2, ".cv-tip-x").dispatchEvent(new /** @type {any} */ (globalThis).Event("contextmenu"));
  assert.deepEqual(g.of("tips.dismiss").map(c => c.input), [{ module: "chat" }]);
  t2.stop();
  vyred({ "tips.next": { tip: null } });
  const s3 = /** @type {any} */ (document.createElement("div"));
  const t3 = mountTip(s3, { busy: () => false, empty: () => true, visible: () => true });
  await settle();
  assert.equal(s3.hidden, true, "no tip, no slot");
  t3.stop();
});

test("tip: Show me copies a command (Copied) or opens its docs page, and marks it acted on", async () => {
  const f = vyred({ "tips.next": { tip: { id: "chat/shell", module: "chat", text: "Type `!` to run a shell line.", command: "vyre tips" } } });
  const slot = /** @type {any} */ (document.createElement("div"));
  const copied = [];
  const t = mountTip(slot, { busy: () => false, empty: () => true, visible: () => true, copy: async s => { copied.push(s); } });
  await settle();
  await $(slot, ".cv-tip-show").click();
  await settle();
  assert.deepEqual(copied, ["vyre tips"]);
  assert.match(text(slot), /Copied/);
  assert.deepEqual(f.of("tips.seen").at(-1).input, { id: "chat/shell", surface: "chat", acted: true });
  t.stop();
  vyred({ "tips.next": { tip: { id: "chat/rewind", module: "chat", text: "Press `Esc Esc` to rewind.", docs: "using/chat.md#rewind" } } });
  const s2 = /** @type {any} */ (document.createElement("div"));
  const opened = [];
  const t2 = mountTip(s2, { busy: () => false, empty: () => true, visible: () => true, open: u => { opened.push(u); } });
  await settle();
  await $(s2, ".cv-tip-show").click();
  assert.deepEqual(opened, ["https://docs.vyre.run/using/chat#rewind"]);
  t2.stop();
});
