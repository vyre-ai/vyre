// @ts-check
// The SSE parser on the frames the box writes (apps/CONTRACT.md 1.4), split at every awkward point.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "./sse.js";

const STREAM =
  ": beat\n\n" +
  'id: 7\nevent: thread.text\ndata: {"id":7,"type":"thread.text","payload":{"text":"hi"}}\n\n' +
  "id: 8\r\nevent: gate.held\r\ndata: {\"id\":8}\r\n\r\n" +
  "data: a\ndata: b\n\n";

/** @param {string[]} chunks */
function parse(chunks) {
  /** @type {import("./sse.js").Frame[]} */ const out = [];
  const p = createSseParser(f => out.push(f));
  for (const c of chunks) p.push(c);
  return out;
}

test("sse: whole stream gives three frames, heartbeats ignored", () => {
  const frames = parse([STREAM]);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], { id: "7", event: "thread.text", data: '{"id":7,"type":"thread.text","payload":{"text":"hi"}}' });
  assert.deepEqual(frames[1], { id: "8", event: "gate.held", data: '{"id":8}' });
  assert.deepEqual(frames[2], { id: null, event: "message", data: "a\nb" });
});

test("sse: one character at a time parses the same", () => {
  assert.deepEqual(parse([...STREAM]), parse([STREAM]));
});

test("sse: a frame without its blank line is held back", () => {
  assert.equal(parse(["id: 1\ndata: {}\n"]).length, 0);
});
