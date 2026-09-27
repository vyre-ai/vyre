// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "./sse.js";

/** Feed `text` through parse() in chunks of `n` characters, as a slow network would. */
function feed(text, n) {
  let buf = "";
  const frames = [];
  for (let i = 0; i < text.length; i += n) {
    const r = parse(buf + text.slice(i, i + n));
    buf = r.rest;
    frames.push(...r.frames);
  }
  return { frames, rest: buf };
}

test("sse: a CRLF stream split between \\r and \\n keeps the frame whole, at any chunk size", () => {
  const text = 'id: 7\r\n\r\nid: 8\r\nevent: gate.held\r\ndata: {"id":8,"type":"gate.held"}\r\n\r\n';
  for (const n of [1, 2, 3, 5, 7, text.length]) {
    const { frames, rest } = feed(text, n);
    assert.deepEqual(frames, [
      { id: "7", event: null, data: "", retry: null },
      { id: "8", event: "gate.held", data: '{"id":8,"type":"gate.held"}', retry: null },
    ], `chunks of ${n}`);
    assert.equal(rest, "");
  }
});

test("sse: bare CR line ends still work, and LF streams are unchanged", () => {
  assert.deepEqual(feed("id: 1\rdata: a\r\rid: 2\ndata: b\n\n", 1).frames.map(f => [f.id, f.data]), [["1", "a"], ["2", "b"]]);
  assert.deepEqual(parse(": hi\n\nretry: 2000\nid: 3\n\n").frames, [{ id: "3", event: null, data: "", retry: 2000 }]);
});
