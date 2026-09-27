// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkVerdict, streamless, holdKeys, utf8Length, withFrom, withMods, arrow, step, reopened, onClose, onAttachError, remember, bytes, QUEUE_MAX } from "./term-link.js";

const failedBeforeOpen = { opened: false, data: false, code: 1006 };
const emptyDrop = { opened: true, data: false, code: 1006 };
const liveDrop = { opened: true, data: true, code: 1006 };

test("term-link: a socket that never opened, or closed 1006 with nothing, carried no stream", () => {
  assert.equal(streamless(failedBeforeOpen), true);
  assert.equal(streamless(emptyDrop), true);
  assert.equal(streamless(liveDrop), false);
  assert.equal(streamless({ opened: true, data: false, code: 1000 }), false);
});

test("term-link: one failure is worth a retry; two in a row mean the path carries no streams", () => {
  assert.equal(linkVerdict([]), "retry");
  assert.equal(linkVerdict([failedBeforeOpen]), "retry");
  assert.equal(linkVerdict([failedBeforeOpen, emptyDrop]), "blocked");
  assert.equal(linkVerdict([failedBeforeOpen, failedBeforeOpen]), "blocked");
});

test("term-link: a stream that was live in between is an ordinary drop", () => {
  assert.equal(linkVerdict([failedBeforeOpen, liveDrop]), "retry");
  assert.equal(linkVerdict([liveDrop, liveDrop]), "retry");
  assert.equal(linkVerdict([failedBeforeOpen, liveDrop, failedBeforeOpen]), "retry");
  assert.equal(linkVerdict([liveDrop, failedBeforeOpen, emptyDrop]), "blocked");
});

test("term-link: keys typed while away are held up to 4 KB, first typed kept", () => {
  let q = holdKeys("", "ls\r");
  assert.deepEqual(q, { queue: "ls\r", dropped: false });
  q = holdKeys("a".repeat(QUEUE_MAX - 2), "bcd");
  assert.equal(q.queue.length, QUEUE_MAX);
  assert.ok(q.queue.endsWith("bc"));
  assert.equal(q.dropped, true);
  assert.deepEqual(holdKeys(q.queue, "x"), { queue: q.queue, dropped: true });
});

test("term-link: withFrom sets the offset on a stream path once", () => {
  assert.equal(withFrom("/v1/streams/term/pty?ticket=abc", 42), "/v1/streams/term/pty?ticket=abc&from=42");
  assert.equal(withFrom("/v1/streams/term/pty?ticket=abc&from=7", 42), "/v1/streams/term/pty?ticket=abc&from=42");
  assert.equal(withFrom("/v1/streams/term/pty?from=7&ticket=abc", 3), "/v1/streams/term/pty?ticket=abc&from=3");
  assert.equal(withFrom("/x", -5), "/x?from=0");
});

test("term-link: Ctrl and Alt from the key bar", () => {
  assert.equal(withMods("c", { ctrl: true }), "\x03");
  assert.equal(withMods("C", { ctrl: true }), "\x03");
  assert.equal(withMods("[", { ctrl: true }), "\x1b");
  assert.equal(withMods(" ", { ctrl: true }), "\x00");
  assert.equal(withMods("b", { alt: true }), "\x1bb");
  assert.equal(withMods("x", { ctrl: true, alt: true }), "\x1b\x18");
  assert.equal(withMods("ab", { ctrl: true }), "ab", "a paste is not a control key");
  assert.equal(withMods("\t"), "\t");
});

test("term-link: arrows follow the cursor mode", () => {
  assert.equal(arrow("up"), "\x1b[A");
  assert.equal(arrow("left", true), "\x1bOD");
});

test("term-link: the key cap counts UTF-8 bytes and keeps a character whole", () => {
  assert.equal(utf8Length("a"), 1);
  assert.equal(utf8Length("\u00e9"), 2);
  assert.equal(utf8Length("\u20ac"), 3);
  assert.equal(utf8Length("\u{1F600}"), 4);
  const q = holdKeys("a".repeat(QUEUE_MAX - 3), "\u20ac\u20ac");
  assert.equal(utf8Length(q.queue), QUEUE_MAX);
  assert.equal(q.dropped, true);
  const r = holdKeys("a".repeat(QUEUE_MAX - 2), "\u20ac");
  assert.deepEqual(r, { queue: "a".repeat(QUEUE_MAX - 2), dropped: true }, "no half a character");
  assert.deepEqual(holdKeys("", ""), { queue: "", dropped: false });
});

const fresh = { offset: 0, drawn: false, caughtUp: false };

test("term-link: binary frames count toward the offset", () => {
  let s = step(fresh, 5).state;
  assert.deepEqual(s, { offset: 5, drawn: true, caughtUp: false });
  s = step(s, 0).state;
  assert.equal(s.offset, 5);
  assert.equal(step(fresh, 0).state.drawn, false, "an empty frame draws nothing");
});

test("term-link: the first at ends the replay and its count is adopted", () => {
  let r = step(step(fresh, 100).state, { t: "at", offset: 100 });
  assert.equal(r.live, true);
  assert.deepEqual(r.state, { offset: 100, drawn: true, caughtUp: true });
  r = step(step(r.state, 20).state, { t: "at", offset: 120 });
  assert.equal(r.live, false, "later ones only move the count");
  assert.equal(r.state.offset, 120);
  const zero = step(fresh, { t: "at", offset: 0 });
  assert.equal(zero.live, true, "a new terminal with nothing printed is live at 0");
  assert.equal(zero.state.offset, 0);
});

test("term-link: a screen ahead of the box adopts the box's count", () => {
  // vyred restarted before it wrote its count down: no replay, and a smaller count.
  const ahead = { offset: 5000, drawn: true, caughtUp: false };
  const r = step(ahead, { t: "at", offset: 4200 });
  assert.equal(r.state.offset, 4200);
  assert.equal(r.live, true);
});

test("term-link: a cut keeps what was drawn, marks the gap, and moves to the oldest byte", () => {
  const away = { offset: 1000, drawn: true, caughtUp: false };
  let r = step(away, { t: "cut", from: 3048, asked: 1000 });
  assert.equal(r.state.offset, 3048);
  assert.equal(r.state.drawn, true, "never a reset");
  assert.match(String(r.mark), /2 KB of output/);
  assert.equal(r.live, false);
  r = step(step(r.state, 52).state, { t: "at", offset: 3100 });
  assert.equal(r.state.offset, 3100);
  assert.equal(r.live, true);
  const cold = step(fresh, { t: "cut", from: 9000, asked: 0 });
  assert.equal(cold.mark, "[Earlier output was not kept]");
  assert.equal(cold.state.offset, 9000);
});

test("term-link: nonsense from the box moves nothing", () => {
  const s = { offset: 10, drawn: true, caughtUp: true };
  for (const m of [{ t: "cut", from: -1 }, { t: "cut", from: "5" }, { t: "at", offset: 1.5 }, { t: "at" }, { t: "size", cols: 80 }, null]) {
    assert.deepEqual(step(s, /** @type {any} */ (m)), { state: s, mark: null, live: false });
  }
});

test("term-link: a new socket keeps the offset and waits for the box to catch up", () => {
  assert.deepEqual(reopened({ offset: 77, drawn: true, caughtUp: true }), { offset: 77, drawn: true, caughtUp: false });
});

test("term-link: 1000 is an end, 1012 a reattach, anything else a drop", () => {
  assert.deepEqual(onClose(1000, "exited"), { act: "end", why: "The shell exited." });
  assert.deepEqual(onClose(1000, "closed"), { act: "end", why: "The terminal was closed." });
  assert.equal(onClose(1000, "stopped").act, "end");
  assert.deepEqual(onClose(1000, ""), { act: "end", why: "The terminal ended." });
  assert.deepEqual(onClose(1012, "restarting"), { act: "reattach" });
  assert.deepEqual(onClose(1006), { act: "retry" });
  assert.deepEqual(onClose(1001, "going away"), { act: "retry" });
});

test("term-link: term.attach refusals: terminal_closed is a box update, not_found an end", () => {
  assert.equal(onAttachError({ code: "terminal_closed" }), "gone");
  assert.equal(onAttachError({ code: "not_found" }), "ended");
  assert.equal(onAttachError({ code: "offline" }), "retry");
  assert.equal(onAttachError({ code: "restarting" }), "retry");
  assert.equal(onAttachError({ code: "http_503" }), "retry");
  assert.equal(onAttachError({ code: "bad_input" }), "error");
  assert.equal(onAttachError(null), "error");
});

test("term-link: the terminals this browser opened, newest first, capped", () => {
  let list = remember(null, { term: "t_a", surface: "deck:x", cwd: "/work/a" });
  list = remember(list, { term: "t_b", surface: "phone:x", cwd: "/work/b" });
  list = remember(list, { term: "t_a", surface: "deck:x", cwd: "/work/a2" });
  assert.deepEqual(list.map(r => r.term), ["t_a", "t_b"]);
  assert.equal(list[0].cwd, "/work/a2");
  assert.deepEqual(remember([{ bad: 1 }, "x"], { term: "t", surface: "deck:x", cwd: "/" }).length, 1);
  let many = [];
  for (let i = 0; i < 20; i++) many = remember(many, { term: "t" + i, surface: "deck:x", cwd: "/" });
  assert.equal(many.length, 16);
  assert.equal(many[0].term, "t19");
});

test("term-link: byte counts in plain words", () => {
  assert.equal(bytes(1), "1 byte");
  assert.equal(bytes(900), "900 bytes");
  assert.equal(bytes(2048), "2 KB");
  assert.equal(bytes(3 * 1024 * 1024), "3.0 MB");
});
