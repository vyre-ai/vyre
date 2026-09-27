// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkVerdict, streamless, holdKeys, withFrom, withMods, arrow, sizeRole, QUEUE_MAX } from "./term-link.js";

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

test("term-link: arrows follow the cursor mode, and who owns the size", () => {
  assert.equal(arrow("up"), "\x1b[A");
  assert.equal(arrow("left", true), "\x1bOD");
  assert.equal(sizeRole("other"), "watch");
  assert.equal(sizeRole("you"), "own");
  assert.equal(sizeRole("none"), "own");
  assert.equal(sizeRole(undefined), "own");
});
