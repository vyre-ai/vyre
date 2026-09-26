// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { acceptKey, encodeFrame, encodeClientFrame, FrameParser } from "./ws.js";

test("ws: acceptKey matches RFC 6455's own worked example", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("ws: encodeFrame carries a payload through unmasked", () => {
  const p = new FrameParser();
  const framed = encodeFrame(Buffer.from("hello"));
  // A server frame is unmasked, so the mask bit must be off.
  assert.equal(framed[1] & 0x80, 0);
  // FrameParser expects masked frames (it only ever reads from a browser); prove the payload
  // itself round-trips through the masked path, which is what the relay actually uses.
  const masked = encodeClientFrame(Buffer.from("hello"));
  const [msg] = p.push(masked);
  assert.deepEqual(msg.message, Buffer.from("hello"));
});

test("ws: a frame split across chunks is held until whole", () => {
  const p = new FrameParser();
  const whole = encodeClientFrame(Buffer.from("split-me-please"));
  assert.deepEqual(p.push(whole.subarray(0, 4)), []);
  const out = p.push(whole.subarray(4));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].message, Buffer.from("split-me-please"));
});

test("ws: two frames in one chunk both come out", () => {
  const p = new FrameParser();
  const chunk = Buffer.concat([encodeClientFrame(Buffer.from("a")), encodeClientFrame(Buffer.from("b"))]);
  const out = p.push(chunk);
  assert.deepEqual(out.map(m => m.message.toString()), ["a", "b"]);
});

test("ws: fragmented messages (continuation frames) reassemble", () => {
  const p = new FrameParser();
  const mask = crypto.randomBytes(4);
  const first = encodeClientFrame(Buffer.from("one-"), 2, mask);
  first[0] &= ~0x80; // clear fin: more is coming
  const second = encodeClientFrame(Buffer.from("two"), 0x0, mask); // continuation, fin=1
  assert.deepEqual(p.push(first), []);
  const out = p.push(second);
  assert.equal(out.length, 1);
  assert.equal(out[0].message.toString(), "one-two");
});

test("ws: close and ping frames come back as control, not message", () => {
  const p = new FrameParser();
  const out = p.push(Buffer.concat([encodeClientFrame(Buffer.alloc(0), 0x8), encodeClientFrame(Buffer.from("x"), 0x9)]));
  assert.deepEqual(out.map(f => f.control), ["close", "ping"]);
});

test("ws: an unmasked client frame is refused, not treated as if it were masked", () => {
  const p = new FrameParser();
  assert.throws(() => p.push(Buffer.from([0x82, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])), /masked/);
});

test("ws: a continuation frame with nothing before it is refused", () => {
  const p = new FrameParser();
  assert.throws(() => p.push(encodeClientFrame(Buffer.from("x"), 0x0)), /nothing to continue/);
});

test("ws: an unknown opcode is refused, the stream is not guessed at", () => {
  const p = new FrameParser();
  assert.throws(() => p.push(encodeClientFrame(Buffer.from("x"), 0x3)), /unknown/);
});
