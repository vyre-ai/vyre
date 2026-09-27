// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkVerdict, streamless, holdKeys, utf8Length, withFrom, withMods, arrow, step, reopened, onClose, onAttachError, remember, bytes, QUEUE_MAX,
  unsized, sizeReopened, drawAt, watching, onFit, onSizeFrame, takeSize, watchLabel, letterbox } from "./term-link.js";

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

test("term-link: a box without size frames: fit and send as before, no Take size", () => {
  let r = onFit(unsized, { cols: 100, rows: 30 });
  assert.deepEqual(r.send, { t: "size", cols: 100, rows: 30 });
  assert.equal(watching(r.state), false);
  assert.deepEqual(drawAt(r.state, { cols: 100, rows: 30 }), { cols: 100, rows: 30 });
  assert.equal(onFit(r.state, { cols: 100, rows: 30 }).send, null, "the same size is not sent twice on one socket");
  assert.deepEqual(onFit(r.state, { cols: 90, rows: 30 }).send, { t: "size", cols: 90, rows: 30 });
  assert.deepEqual(onFit(sizeReopened(r.state), { cols: 100, rows: 30 }).send, { t: "size", cols: 100, rows: 30 }, "a new socket sends again");
  assert.equal(onFit(unsized, null).send, null, "not measured yet: nothing");
  assert.equal(onFit(unsized, { cols: 0, rows: 30 }).send, null);
});

test("term-link: owner:false watches at the owner's size, and a fit still says what this screen would like", () => {
  const phone = { cols: 50, rows: 20 };
  let r = onSizeFrame(unsized, { t: "size", cols: 120, rows: 40, owner: false }, phone);
  assert.equal(r.send, null, "a watcher never answers a size frame");
  assert.equal(watching(r.state), true);
  assert.equal(watchLabel(r.state), "Watching at 120x40");
  assert.deepEqual(drawAt(r.state, phone), { cols: 120, rows: 40 }, "drawn at the owner's size, not reflowed");
  const f = onFit(r.state, phone);
  assert.deepEqual(f.send, { t: "size", cols: 50, rows: 20 }, "kept by the box as this screen's wanted size");
  assert.equal(watching(f.state), true);
  // The box answers that size with owner:false: nothing goes back.
  assert.equal(onSizeFrame(f.state, { t: "size", cols: 120, rows: 40, owner: false }, phone).send, null);
});

test("term-link: owner:true fits this screen; it resends only when the box's size is not its own", () => {
  const mine = { cols: 100, rows: 30 };
  let r = onSizeFrame(unsized, { t: "size", cols: 100, rows: 30, owner: true }, mine);
  assert.equal(r.send, null);
  assert.equal(watching(r.state), false);
  assert.deepEqual(drawAt(r.state, mine), mine);
  // Became owner when the laptop left, at the size it asked for a while ago: send the current fit.
  const w = onSizeFrame({ ...unsized, known: true, owner: false, cols: 120, rows: 40 }, { t: "size", cols: 50, rows: 20, owner: true }, mine);
  assert.deepEqual(w.send, { t: "size", cols: 100, rows: 30 });
  // A box that clamps the size answers with something else: no loop.
  assert.equal(onSizeFrame(w.state, { t: "size", cols: 99, rows: 30, owner: true }, mine).send, null);
});

test("term-link: Take size sends take with this screen's fitted size; the box's owner:true settles it", () => {
  const phone = { cols: 50, rows: 20 };
  const watch = onSizeFrame(unsized, { t: "size", cols: 120, rows: 40, owner: false }, phone).state;
  const t = takeSize(watch, phone);
  assert.deepEqual(t.send, { t: "take", cols: 50, rows: 20 });
  assert.equal(watching(t.state), true, "still watching until the box says otherwise");
  const r = onSizeFrame(t.state, { t: "size", cols: 50, rows: 20, owner: true }, phone);
  assert.equal(r.send, null);
  assert.equal(watching(r.state), false);
  assert.deepEqual(takeSize(watch, null).send, { t: "take" }, "not measured: the box uses the size last asked for");
  // Another screen takes it back: watching again, at its size.
  assert.equal(watching(onSizeFrame(r.state, { t: "size", cols: 120, rows: 40, owner: false }, phone).state), true);
});

test("term-link: size frames the box never sends change nothing", () => {
  for (const m of [null, { t: "size", cols: 80, rows: 24 }, { t: "size", cols: 0, rows: 24, owner: true }, { t: "size", cols: "80", rows: 24, owner: false }, { t: "at", offset: 3 }]) {
    assert.deepEqual(onSizeFrame(unsized, m, { cols: 80, rows: 24 }), { state: unsized, send: null });
  }
});

test("term-link: letterbox scales a larger terminal down, centred, and never up", () => {
  assert.deepEqual(letterbox({ w: 1000, h: 500 }, { w: 500, h: 500 }), { scale: 0.5, x: 0, y: 125 });
  assert.deepEqual(letterbox({ w: 400, h: 200 }, { w: 500, h: 300 }), { scale: 1, x: 50, y: 50 });
  assert.deepEqual(letterbox({ w: 0, h: 0 }, { w: 500, h: 300 }), { scale: 1, x: 0, y: 0 });
});
