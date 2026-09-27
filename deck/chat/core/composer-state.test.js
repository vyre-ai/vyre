// @ts-check
// The composer's rules, shared by the Deck and the phone: the draft's mode, mentions, history,
// Enter, Esc, Shift+Tab, the key map and pasted images. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODES, nextMode, modeLabel, draftKind, draftBody, kindLabel, findMention, applyMention, rankFiles,
  createHistory, remember, recall, recalling, stopRecall, historyStore, upAction, enterAction,
  createEsc, escape, KEYMAP, binding, keyOf, actionFor, addImage, removeImage, sendImages, b64Bytes, newUuid,
  modelChoices, shortModel,
} from "./composer-state.js";
import { scorePath, compareScores } from "./match.js";

test("the draft's mode is its first character; its body drops the character", () => {
  assert.equal(draftKind("/compact"), "command");
  assert.equal(draftKind("!git status --short"), "shell");
  assert.equal(draftKind("# Harlow letters write dates as 27 September 2026"), "memory");
  assert.equal(draftKind("Use Estate intake v2"), "message");
  assert.equal(draftKind(" /not a command"), "message", "only the very first character");
  assert.equal(draftKind(""), "message");
  assert.equal(draftBody("!  npm run lint "), "npm run lint");
  assert.equal(draftBody("#probate needs the executor"), "probate needs the executor");
  assert.equal(draftBody("/compact keep todos"), "/compact keep todos", "a command keeps its slash");
  assert.equal(kindLabel("shell"), "Shell");
  assert.equal(kindLabel("memory"), "Memory");
  assert.equal(kindLabel("message"), null);
});

test("an @ mention at the caret, anywhere in the draft; an email is not one", () => {
  assert.deepEqual(findMention("Move the fields to @est", 23), { start: 19, end: 23, query: "est" });
  assert.deepEqual(findMention("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(findMention("see (@src/int", 13), { start: 5, end: 13, query: "src/int" });
  assert.equal(findMention("mail alex@harlow.test", 21), null);
  assert.equal(findMention("@src/app.js done", 16), null, "past the word");
  assert.deepEqual(findMention("@src/app.js done", 5), { start: 0, end: 5, query: "src/" }, "the caret decides");
  assert.deepEqual(applyMention("Compare @est and v1", { start: 8, end: 12, query: "est" }, "src/intake/estate.ts"),
    { text: "Compare @src/intake/estate.ts and v1", caret: 30 });
  assert.deepEqual(applyMention("@my", { start: 0, end: 3, query: "my" }, "docs/my notes.md"), { text: '@"docs/my notes.md" ', caret: 20 });
});

test("files for @: inside the folder only, best match first, then the newest", () => {
  const cwd = "/home/alex/work/harlow-legal";
  const files = [
    { path: `${cwd}/docs/estate-intake.md`, mtime: 10 },
    { path: `${cwd}/src/intake/estate.ts`, mtime: 30 },
    { path: `${cwd}/src/intake/estate-v2.ts`, mtime: 40 },
    { path: "/home/alex/work/northwind-bakery/estate.ts", mtime: 99 },
    { path: `${cwd}/src/intake/general.ts`, mtime: 50 },
  ];
  const got = rankFiles(files, "estate", cwd, scorePath, compareScores);
  // All three match "estate" as a whole word; the earlier match wins, then the newer file.
  assert.deepEqual(got.map(f => f.rel), ["docs/estate-intake.md", "src/intake/estate-v2.ts", "src/intake/estate.ts"]);
  assert.ok(got.every(f => f.path.startsWith(cwd)));
  assert.deepEqual(rankFiles(files, "", cwd, scorePath, compareScores, 2).map(f => f.rel), ["src/intake/general.ts", "src/intake/estate-v2.ts"], "no query: newest first");
});

test("history: Up for older, Down back to what was typed, not twice in a row, capped", () => {
  const h = createHistory(3);
  for (const t of ["one", "two", "two", "three", "four"]) remember(h, t);
  assert.deepEqual(h.entries, ["two", "three", "four"]);
  assert.equal(recall(h, "down", "draft"), null, "nothing to go down to");
  assert.equal(recall(h, "up", "half typed"), "four");
  assert.equal(recalling(h), true);
  assert.equal(recall(h, "up", "four"), "three");
  assert.equal(recall(h, "up", "three"), "two");
  assert.equal(recall(h, "up", "two"), null, "the oldest");
  assert.equal(recall(h, "down", "two"), "three");
  assert.equal(recall(h, "down", "three"), "four");
  assert.equal(recall(h, "down", "four"), "half typed", "past the newest: what was there");
  assert.equal(recalling(h), false);
  recall(h, "up", "");
  stopRecall(h);
  assert.equal(recalling(h), false);
  remember(h, "   ");
  assert.equal(h.entries.length, 3, "blank is not remembered");
});

test("history per thread, least recently used dropped, and kept across reloads", () => {
  const st = historyStore(100, 2);
  remember(st.get("th-harlow"), "Rebuild the intake");
  remember(st.get("th-northwind"), "Draft the menu");
  st.get("th-harlow");
  remember(st.get("th-kit"), "Hello kit");
  assert.deepEqual(Object.keys(st.toJSON()).sort(), ["th-harlow", "th-kit"]);
  const again = historyStore();
  again.load(JSON.parse(JSON.stringify(st.toJSON())));
  assert.deepEqual(again.get("th-harlow").entries, ["Rebuild the intake"]);
  again.load("junk");
  again.load({ x: "not a list" });
  assert.deepEqual(again.get("x").entries, []);
});

test("Up: edits the newest queued message in an empty composer, else recalls", () => {
  assert.equal(upAction({ text: "", firstLine: true, recalling: false, queued: 1 }), "edit-queued");
  assert.equal(upAction({ text: "  ", firstLine: true, recalling: false, queued: 0 }), "recall");
  assert.equal(upAction({ text: "Use v2", firstLine: true, recalling: true, queued: 0 }), "recall");
  assert.equal(upAction({ text: "Use v2\nand more", firstLine: false, recalling: true, queued: 0 }), "none");
  assert.equal(upAction({ text: "typing", firstLine: true, recalling: false, queued: 2 }), "none");
});

test("Enter: idle sends; running steers by default and queues with Alt, the toggle or a hold", () => {
  const msg = "Keep the witness page as its own step";
  assert.deepEqual(enterAction({ text: msg, running: false }), { do: "send", kind: "message", mode: null });
  assert.deepEqual(enterAction({ text: msg, running: true }), { do: "send", kind: "message", mode: "steer" });
  assert.deepEqual(enterAction({ text: msg, running: true, alt: true }), { do: "send", kind: "message", mode: "queue" });
  assert.deepEqual(enterAction({ text: msg, running: true, queueToggle: true }), { do: "send", kind: "message", mode: "queue" });
  assert.deepEqual(enterAction({ text: msg, running: true, button: true, hold: true }), { do: "send", kind: "message", mode: "queue" });
  assert.deepEqual(enterAction({ text: msg, running: false, alt: true }), { do: "send", kind: "message", mode: null }, "nothing to queue behind");
  assert.deepEqual(enterAction({ text: "/compact", running: true }), { do: "send", kind: "command", mode: "queue" }, "a command waits for the turn");
  assert.deepEqual(enterAction({ text: "!git status", running: true }), { do: "send", kind: "shell", mode: null });
  assert.deepEqual(enterAction({ text: "#dates as 27 September 2026", running: false }), { do: "send", kind: "memory", mode: null });
  assert.deepEqual(enterAction({ text: "!", running: false }), { do: "none" }, "a mode character alone");
  assert.deepEqual(enterAction({ text: msg, running: false, shift: true }), { do: "newline" });
  assert.deepEqual(enterAction({ text: msg, running: false, touch: true }), { do: "newline" }, "a phone's Enter is a new line");
  assert.deepEqual(enterAction({ text: msg, running: false, touch: true, button: true }), { do: "send", kind: "message", mode: null }, "its send button sends");
  assert.deepEqual(enterAction({ text: msg, running: false, pickerOpen: true }), { do: "pick" });
  assert.deepEqual(enterAction({ text: msg, running: false, composing: true }), { do: "none" });
  assert.deepEqual(enterAction({ text: "  ", running: false }), { do: "none" });
  assert.deepEqual(enterAction({ text: "", running: false, images: 1 }), { do: "send", kind: "message", mode: null }, "an image alone");
});

test("Esc: stops a turn, twice rewinds (empty) or clears (words), closes a picker, leaves shell mode", () => {
  const st = createEsc(800);
  assert.equal(escape(st, { now: 1000, running: true, text: "" }), "interrupt");
  assert.equal(escape(st, { now: 1500, running: false, text: "" }), "rewind");
  assert.equal(escape(st, { now: 5000, running: false, text: "" }), "none", "one press while idle arms");
  assert.equal(escape(st, { now: 5900, running: false, text: "" }), "none", "too slow: a first press again");
  assert.equal(escape(st, { now: 6000, running: false, text: "half a thought" }), "clear");
  assert.equal(escape(st, { now: 9000, running: false, text: "", pickerOpen: true }), "close");
  assert.equal(escape(st, { now: 9100, running: false, text: "" }), "none", "the picker's press does not count toward two");
  assert.equal(escape(createEsc(), { now: 1, running: false, text: "!npm run lint" }), "leave-mode");
  assert.equal(escape(createEsc(), { now: 1, running: false, text: "#remember this" }), "leave-mode");
  assert.equal(escape(createEsc(), { now: 1, running: false, text: "Use v2", recalled: true }), "clear");
});

test("Shift+Tab walks default, acceptEdits and plan, never bypass", () => {
  assert.equal(nextMode("default"), "acceptEdits");
  assert.equal(nextMode("acceptEdits"), "plan");
  assert.equal(nextMode("plan"), "default");
  assert.equal(nextMode(null), "acceptEdits");
  assert.equal(nextMode("plan", MODES), "default", "bypass is never reached, even when a session lists it");
  assert.equal(nextMode("bypassPermissions"), "default", "a session started in bypass steps out of it");
  assert.equal(nextMode("default", ["plan", "default"]), "plan", "the offered ones, in the usual order");
  assert.equal(modeLabel("default"), "Asks first");
  assert.equal(modeLabel("acceptEdits"), "Accepts edits");
  assert.equal(modeLabel("plan"), "Plan mode");
  assert.equal(modeLabel(null), "Asks first");
});

test("the key map: every binding once, read the same way on a Mac and elsewhere", () => {
  assert.equal(new Set(KEYMAP.map(b => b.id)).size, KEYMAP.length);
  assert.ok(Object.isFrozen(KEYMAP));
  assert.ok(KEYMAP.every(b => !/claude/i.test(b.does)));
  assert.equal(binding("queue")?.label, "⌥⏎");
  const k = (/** @type {any} */ e, mac = false) => actionFor({ shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...e }, mac);
  assert.equal(k({ key: "Tab", shiftKey: true }), "mode");
  assert.equal(k({ key: "Enter", altKey: true, code: "Enter" }), "queue");
  assert.equal(k({ key: "Enter", shiftKey: true }), "newline");
  assert.equal(k({ key: "Enter" }), "send");
  assert.equal(k({ key: "Escape" }), "stop");
  assert.equal(k({ key: "ArrowUp" }), "recall");
  assert.equal(k({ key: "†", code: "KeyT", altKey: true }, true), "thinking", "a Mac's Option+T types a dagger");
  assert.equal(k({ key: "o", ctrlKey: true }), "thinking-view");
  assert.equal(k({ key: "o", ctrlKey: true }, true), "thinking-view", "Ctrl on a Mac too");
  assert.equal(k({ key: "b", ctrlKey: true }), "tasks");
  assert.equal(k({ key: "v", metaKey: true }, true), "paste");
  assert.equal(k({ key: "v", ctrlKey: true }), "paste");
  assert.equal(k({ key: "v", metaKey: true }), null, "Meta+V is not paste off a Mac");
  assert.equal(k({ key: "a" }), null);
  assert.equal(keyOf({ key: "Tab", shiftKey: true }), "Shift+Tab");
});

test("pasted images: types, a count cap and a size cap; the list is never changed in place", () => {
  const png = { media_type: "image/png", data: "iVBORw0KGgo=", name: "Screenshot 14:36" };
  let r = addImage([], png);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.list, [{ media_type: "image/png", data: "iVBORw0KGgo=", size: 8, name: "Screenshot 14:36" }]);
  const one = r.list;
  r = addImage(one, { media_type: "application/pdf", data: "JVBERi0=" });
  assert.match(String(r.error), /PNG, JPEG, GIF and WebP/);
  assert.equal(r.list.length, 1);
  assert.notEqual(r.list, one);
  r = addImage(one, { media_type: "image/jpeg", data: "x", size: 6 * 1024 * 1024 });
  assert.match(String(r.error), /over 5 MB/);
  let list = one;
  for (let i = 0; i < 3; i++) list = addImage(list, png).list;
  assert.equal(list.length, 4);
  assert.match(String(addImage(list, png).error), /At most 4 images/);
  assert.equal(removeImage(list, 0).length, 3);
  assert.deepEqual(sendImages(one), [{ media_type: "image/png", data: "iVBORw0KGgo=" }]);
  assert.equal(b64Bytes("iVBORw0KGgo="), 8);
  assert.equal(b64Bytes("TWFu"), 3);
});

test("uuids are v4 shaped, with or without crypto", () => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert.match(newUuid(), re);
  const c = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try { assert.match(newUuid(), re); } finally { if (c) Object.defineProperty(globalThis, "crypto", c); }
});

test("the model picker: the aliases, then the ids the per-purpose map and the thread name, 'now' on the thread's", () => {
  const plain = modelChoices({ current: "opus" });
  assert.deepEqual(plain.map(m => [m.id, m.now]), [["opus", true], ["sonnet", false], ["haiku", false]]);
  const got = modelChoices({
    current: "claude-sonnet-4-5",
    purposes: { chat: { model: "opus", from: "config:chat" }, agent: { model: "opus", from: "config:agent" }, job: { model: "claude-haiku-4-5", from: "purpose:job" } },
  });
  assert.deepEqual(got.map(m => m.id), ["opus", "sonnet", "haiku", "claude-haiku-4-5", "claude-sonnet-4-5"]);
  assert.equal(got[0].description, "Used for chat, agent");
  assert.equal(got[3].description, "Used for job");
  assert.deepEqual(got.filter(m => m.now).map(m => m.id), ["claude-sonnet-4-5"], "the exact id wins over its family");
  assert.deepEqual(modelChoices({ current: "claude-opus-4-5[1m]" }).filter(m => m.now).map(m => m.id), ["claude-opus-4-5[1m]"]);
  assert.deepEqual(modelChoices({ current: null, purposes: { chat: { model: "<b>x</b>" } } }).map(m => m.id), ["opus", "sonnet", "haiku"], "only what a model id can be");
  assert.equal(shortModel("claude-opus-4-5"), "opus");
});
