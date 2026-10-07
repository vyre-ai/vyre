// @ts-check
// The screen's pure parts: keys, width, fuzzy matching, the model, the transcript and the
// layout, each without a terminal or vyred.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyParser } from "./keys.js";
import { width, clip, fit, wrap, sanitize, stripAnsi } from "./width.js";
import { match, rank, highlight } from "./fuzzy.js";
import * as model from "./model.js";
import { transcript, apply, load } from "./transcript.js";
import { render } from "./layout.js";
import { formatLink } from "./live.js";

const names = keys => keys.map(k => (k.name === "char" ? k.text : k.name === "paste" ? `paste(${k.text})` : k.name));

test("keys: arrows in both forms, split sequences wait for the rest, a lone Esc waits for flush", () => {
  const p = keyParser();
  assert.deepEqual(names(p.feed("\x1b[A\x1bOB\r\x7f\t")), ["up", "down", "enter", "backspace", "tab"]);
  assert.deepEqual(names(p.feed("\x1b[")), [], "half an arrow is not a key yet");
  assert.deepEqual(names(p.feed("5~ab")), ["pageup", "a", "b"]);
  assert.deepEqual(names(p.feed("\x1b")), []);
  assert.equal(p.pending, true);
  assert.deepEqual(names(p.flush()), ["esc"]);
  assert.deepEqual(names(p.feed("\x1b\r")), ["esc", "enter"], "Esc then Enter in one chunk lost the Esc");
  assert.deepEqual(names(p.feed("\x1b[1;5C\x03\x0c")), ["right", "ctrl-c", "ctrl-l"], "a modified arrow reads as the arrow");
  assert.deepEqual(names(p.feed("é漢😀")), ["é", "漢", "😀"]);
  assert.deepEqual(names(p.feed("\r\n")), ["enter"], "CRLF is one Enter");
});

test("keys: a bracketed paste is one key, even across chunks, and never runs as commands", () => {
  const p = keyParser();
  assert.deepEqual(names(p.feed("x\x1b[200~q\rab")), ["x"]);
  assert.deepEqual(names(p.feed("c\x1b[201~y")), ["paste(q\rabc)", "y"]);
  assert.deepEqual(names(p.feed("\x1b[200~half")), []);
  assert.deepEqual(names(p.flush()), ["paste(half)"], "an unfinished paste is kept as text");
});

test("width: wide characters take two columns, marks none; clip and fit never pass the width", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width("漢字"), 4);
  assert.equal(width("😀"), 2);
  assert.equal(width("é"), 1);
  assert.equal(width("\x1b[1mbold\x1b[0m"), 4);
  for (const s of ["Harlow Legal intake", "漢字漢字漢字漢字", "😀😀😀😀😀😀", "a😀b漢c"]) {
    for (let n = 1; n < 12; n++) {
      assert.ok(width(clip(s, n)) <= n, `clip(${s}, ${n}) = ${clip(s, n)}`);
      assert.equal(width(fit(s, n)), n);
    }
  }
  assert.equal(clip("Northwind Bakery", 9), "Northwin…");
  assert.deepEqual(wrap("the quick brown fox", 9), ["the quick", "brown fox"]);
  assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  for (const l of wrap("漢字漢字漢字 and more words here", 5)) assert.ok(width(l) <= 5, l);
});

test("width: sanitize removes every escape and control, so output cannot drive the terminal", () => {
  const evil = "hi\x1b]0;title\x07\x1b[2J\x1b[?1049l\x07\r\nthere\x9b";
  assert.equal(sanitize(evil), "hi there");
  assert.equal(sanitize(evil, { newlines: true }), "hi\nthere");
  assert.equal(stripAnsi("\x1b[38;2;1;2;3mx\x1b[0m"), "x");
});

test("fuzzy: a subsequence in order matches; together, word starts and early matches score higher", () => {
  assert.ok(match("nor", "Northwind"));
  assert.equal(match("xyz", "Northwind"), null);
  assert.equal(match("dniw", "Northwind"), null, "out of order");
  assert.ok(match("hl", "Harlow Legal"));
  assert.ok(match("har leg", "Harlow Legal"), "every word must match");
  assert.equal(match("har bak", "Harlow Legal"), null);
  const r = rank([{ label: "Invoice run for Northwind" }, { label: "Northwind" }, { label: "n o r" }], "nor", x => x);
  assert.equal(r[0].item.label, "Northwind");
  assert.deepEqual(r[0].positions, [0, 1, 2]);
  assert.equal(highlight("Northwind", [0, 1, 2], s => `[${s}]`), "[Nor]thwind");
  // The detail matches only as a fallback, below every label match.
  const d = rank([{ label: "Weekly planning", detail: "Harlow Legal" }, { label: "Harlow site" }], "harlow", x => x);
  assert.deepEqual(d.map(x => x.item.label), ["Harlow site", "Weekly planning"]);
});

const data = (over = {}) => /** @type {model.Data} */ ({
  projects: [{ slug: "harlow-legal", name: "Harlow Legal", threads: 2, last: Date.now() - 3_600_000, home: "/w/harlow" },
    { slug: "northwind", name: "Northwind Bakery", threads: 1, last: 0, home: "/w/northwind" }],
  agents: [{ name: "juno", kind: "assistant", status: "idle" }], here: null,
  threads: [{ id: "t-harlow-1", name: "intake review", project: "harlow-legal", status: "working", cwd: "/w/harlow", holder: null, asks: 1, last: Date.now() },
    { id: "t-loose-1", name: null, project: null, status: "idle", cwd: "/w/scratch/kit", holder: null, asks: 0, last: Date.now() }],
  asks: [{ id: "ask-1", thread: "t-harlow-1", tool: "Write", summary: "notes.md", destination: "/w/harlow/notes.md", reason: null, at: Date.now() }],
  drafts: [{ id: "g-1", kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Intake follow-up", agent: "juno", at: Date.now() }],
  sessions: { "harlow-legal": [{ id: "s-1", label: "Weekly planning", cwd: "/w/harlow", last: Date.now(), how: ["folder"] }, { id: "t-harlow-1", label: "dup of the headless one", cwd: "/w/harlow" }] },
  ...over,
});
const press = (st, ...keys) => {
  let effect;
  for (const k of keys) {
    const key = typeof k === "string" && k.length === 1 ? { name: "char", text: k } : typeof k === "string" ? { name: k } : k;
    const r = model.reduce(st, key);
    st = r.st;
    if (r.effect) effect = r.effect;
  }
  return { st, effect };
};

test("model: the tree is Inbox, Projects, New session, headless threads, Agents; the folder's project starts selected", () => {
  const d = data();
  const kinds = model.items(d, []).map(i => i.kind);
  assert.deepEqual(kinds, ["header", "ask", "draft", "header", "project", "project", "new", "header", "thread", "header", "agent"]);
  assert.equal(model.initial(d).cursor, "project:harlow-legal");
  assert.equal(model.initial(data({ here: "northwind" })).cursor, "project:northwind");
  const open = model.items(d, ["harlow-legal"]).map(i => i.key);
  assert.deepEqual(open.slice(4, 9), ["project:harlow-legal", "new-in:harlow-legal", "thread:t-harlow-1", "h:sessions:harlow-legal", "session:harlow-legal:s-1"],
    "a headless thread shows once, as the thread, not again as a session");
  assert.equal(model.items(data({ drafts: null }), []).filter(i => i.kind === "draft").length, 0);
  assert.equal(model.items(data({ asks: [], drafts: [] }), [])[1].kind, "note");
});

test("model: Enter opens a project onto New session in it; Esc and left close it; down reaches its sessions", () => {
  let { st, effect } = press(model.initial(data()), "enter");
  assert.equal(st.cursor, "new-in:harlow-legal");
  assert.equal(effect, undefined, "sessions were already loaded");
  assert.equal(press(st, "enter").effect?.type, "new-in");
  assert.equal(press(st, "down").st.cursor, "thread:t-harlow-1");
  assert.equal(press(st, "down", "down").st.cursor, "session:harlow-legal:s-1", "the cursor stopped on a header");
  const resumed = /** @type {any} */ (press(st, "down", "down", "enter").effect);
  assert.deepEqual([resumed.type, resumed.session.id, resumed.session.project], ["resume", "s-1", "harlow-legal"]);
  const closed = press(st, "esc").st;
  assert.equal(closed.cursor, "project:harlow-legal");
  assert.deepEqual(closed.open, []);
  assert.deepEqual(press(st, "down", "left").st.open, []);
  // A project whose sessions have not loaded asks for them.
  assert.deepEqual(press(model.initial(data()), "down", "right").effect, { type: "load", project: "northwind" });
});

test("model: typing filters everything, sessions of closed projects included; q quits only when nothing is typed", () => {
  const st0 = model.initial(data());
  const f = press(st0, "w", "e", "e", "k").st;
  assert.equal(model.current(f)?.label, "Weekly planning");
  assert.match(model.current(f)?.detail || "", /Harlow Legal/, "a filtered session says which project it is in");
  assert.equal(press(f, "enter").effect?.type, "resume");
  assert.equal(press(st0, "q").effect?.type, "quit");
  const typed = press(st0, "n", "q");
  assert.equal(typed.effect, undefined);
  assert.equal(typed.st.filter, "nq");
  assert.equal(press(typed.st, "esc").st.filter, "");
  assert.equal(press(st0, "x", "backspace", "n", "o", "r", "enter").st.cursor, "new-in:northwind", "Enter on a filtered project opens it");
  assert.equal(press(st0, { name: "paste", text: "juno\n" }).st.filter, "juno ");
  assert.equal(press(st0, "ctrl-c").effect?.type, "quit");
});

test("model: a and d answer the selected ask, a and r the selected draft; Enter asks first; ? shows help", () => {
  // One data(): it stamps Date.now(), which may tick between two calls.
  const d = data();
  const st0 = model.initial(d);
  const onAsk = press(st0, "home").st;
  assert.equal(onAsk.cursor, "ask:ask-1");
  assert.deepEqual(press(onAsk, "a").effect, { type: "answer", ask: d.asks[0], decision: "allow" });
  assert.equal(press(onAsk, "d").effect?.decision, "deny");
  const line = press(onAsk, "enter").st;
  assert.equal(line.action, "ask");
  assert.equal(press(line, "esc").st.action, null);
  assert.equal(press(line, "esc").effect, undefined);
  assert.equal(press(line, "y").effect?.decision, "allow");
  const onDraft = press(onAsk, "down").st;
  assert.equal(press(onDraft, "r").effect?.decision, "reject");
  assert.equal(press(onDraft, "a").effect?.decision, "approve");
  assert.equal(press(onDraft, "d").effect, undefined, "d is not a draft key: it filters");
  const help = press(st0, "?").st;
  assert.equal(help.help, true);
  assert.equal(press(help, "q").st.help, false);
  assert.equal(press(help, "q").effect, undefined, "q closes help, it does not quit");
});

test("model: Tab types into a headless thread, Enter sends, Esc goes back; ctrl-l takes the keyboard", () => {
  const st0 = model.initial(data());
  const onThread = press(st0, "enter", "down").st;
  const typing = press(onThread, "tab", "h", "i", { name: "paste", text: " there" }).st;
  assert.equal(typing.focus, "compose");
  assert.equal(typing.compose, "hi there");
  const sent = press(typing, "enter");
  assert.deepEqual(sent.effect && { type: sent.effect.type, text: /** @type {any} */ (sent.effect).text }, { type: "send", text: "hi there" });
  assert.equal(sent.st.compose, "");
  assert.equal(press(typing, "q").st.compose, "hi thereq", "q is a letter while typing");
  assert.equal(press(typing, "esc").st.focus, "list");
  assert.equal(press(typing, "ctrl-l").effect?.type, "lease");
  assert.match(press(st0, "tab").st.status, /headless thread/);
});

test("model: new data keeps the cursor on its item, or the next one when it went", () => {
  const st = press(model.initial(data()), "home").st;
  assert.equal(model.withData(st, data()).cursor, "ask:ask-1");
  assert.equal(model.withData(st, data({ asks: [] })).cursor, "draft:g-1", "the answered ask left: the next item is selected");
  assert.equal(model.liveHolder("cli:999999999", () => false), null);
  assert.equal(model.liveHolder("deck:phone", () => false), "deck:phone");
});

test("transcript: deltas stream on one line, the backlog and the stream overlap without repeats, early events wait", () => {
  const tr = transcript();
  apply(tr, { id: 5, type: "thread.text", payload: { message: "m2", delta: "late " } });
  load(tr, [
    { id: 1, type: "thread.sent", payload: { text: "hello", surface: "cli:1" } },
    { id: 2, type: "thread.text", payload: { message: "m1", delta: "echo: " } },
    { id: 3, type: "thread.text", payload: { message: "m1", delta: "hello" } },
    { id: 4, type: "thread.text", payload: { message: "m1", done: true, text: "echo: hello" } },
  ]);
  apply(tr, { id: 3, type: "thread.text", payload: { message: "m1", delta: "hello" } });
  apply(tr, { id: 6, type: "ask.raised", payload: { ask: "a1", tool: "Write", summary: "x.md" } });
  apply(tr, { id: 7, type: "thread.text", payload: { message: "m3", delta: "\x1b[2Jclean" } });
  assert.deepEqual(tr.lines.map(l => l.text), ["  > hello  (cli:1)", "echo: hello", "late ", "? Write: x.md", "  in the Inbox: a allows, d denies", "clean"]);
  assert.deepEqual(tr.lines.map(l => l.style), ["sent", "text", "text", "beacon", "dim", "text"]);
});

test("layout: exactly rows lines, none wider than the terminal, at every size, in every state", () => {
  const d = data();
  const trs = new Map([["t-harlow-1", (() => { const t = transcript(); load(t, [{ id: 1, type: "thread.text", payload: { message: "m", done: true, text: "a long reply ".repeat(40) + "漢字😀".repeat(20) } }]); return t; })()]]);
  const states = [model.initial(d), press(model.initial(d), "home").st, press(model.initial(d), "enter", "down", "tab", "h", "i").st,
    press(model.initial(d), "?").st, press(model.initial(d), "w", "e", "e").st, press(model.initial(d), "z", "z", "z").st];
  for (const st of states) {
    for (const [columns, rows] of [[100, 30], [80, 24], [60, 20], [40, 10], [20, 6], [200, 60]]) {
      const lines = render(st, { columns, rows, transcripts: trs });
      assert.equal(lines.length, rows, `${columns}x${rows}`);
      for (const l of lines) assert.ok(width(l) <= columns, `${columns}x${rows}: a line is ${width(l)} wide: ${stripAnsi(l)}`);
    }
  }
  const text = render(press(model.initial(d), "home").st, { columns: 100, rows: 30 }).map(stripAnsi).join("\n");
  assert.match(text, /Inbox \(2\)/);
  assert.match(text, /a allows · d denies/);
  assert.match(render(model.initial(d), { columns: 100, rows: 30 }).map(stripAnsi)[0], /1 working · 1 ask · 1 held/);
});

test("status line: link.health's real shape reads as a phrase; a box, or an unpaired Mac, shows none", () => {
  assert.equal(formatLink({ path: "direct", latencyMs: 23.4, relay: null }), "link direct 23 ms");
  assert.equal(formatLink({ path: "relay", relay: "fra", latencyMs: 80 }), "link relayed 80 ms");
  assert.equal(formatLink({ path: "unknown", why: "the node is offline" }), "link down");
  assert.equal(formatLink({ path: "unknown", why: "this Mac is not paired with a box" }), "");
  assert.equal(formatLink({ path: "unknown", why: "say which node: a paired Mac's node id (vyre link peers)" }), "");
});

test("model: something from a few seconds ago is now, not 1m", () => {
  assert.equal(model.ago(Date.now() - 5_000), "now");
  assert.equal(model.ago(Date.now() - 90_000), "2m");
});
