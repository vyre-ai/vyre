// @ts-check
// ring.js: byte offsets, since(from) exact vs cut, the newline-aligned drop, and the holder wire
// (frames, a Reader across split chunks, MAX_FRAME splitting). Pure, no pty: runs anywhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Ring, Reader, T, frame, outFrames, json, MAX_FRAME } from "./ring.js";

const B = s => Buffer.from(s);

test("ring: every byte has an offset; start and end move as bytes arrive", () => {
  const r = new Ring(1024);
  assert.equal(r.start, 0); assert.equal(r.end, 0);
  r.push(B("abc"));
  r.push(B(""));
  r.push(B("de\n"));
  assert.equal(r.start, 0); assert.equal(r.end, 6);
  assert.equal(r.bytes, 6);
});

test("ring: since(from) is exact while from is in the ring", () => {
  const r = new Ring(1024);
  r.push(B("hello ")); r.push(B("world\n"));
  const a = r.since(0);
  assert.deepEqual({ from: a.from, cut: a.cut, s: a.bytes.toString() }, { from: 0, cut: false, s: "hello world\n" });
  const b = r.since(6);
  assert.deepEqual({ from: b.from, cut: b.cut, s: b.bytes.toString() }, { from: 6, cut: false, s: "world\n" });
  const c = r.since(r.end);
  assert.deepEqual({ from: c.from, cut: c.cut, n: c.bytes.length }, { from: 12, cut: false, n: 0 });
  // Across a chunk boundary.
  const d = r.since(4);
  assert.equal(d.bytes.toString(), "o world\n");
});

test("ring: an offset that left the ring, a future one, or none gets the whole ring", () => {
  const r = new Ring(1024);
  const line = "x".repeat(99) + "\n";
  for (let i = 0; i < 30; i++) r.push(B(line)); // 3000 bytes into 1024
  assert.ok(r.start > 0);
  assert.ok(r.bytes <= 1024);
  const gone = r.since(10);
  assert.equal(gone.cut, true); assert.equal(gone.from, r.start); assert.equal(gone.bytes.length, r.bytes);
  const ahead = r.since(r.end + 5);
  assert.equal(ahead.cut, true); assert.equal(ahead.from, r.start);
  const none = r.since(undefined);
  assert.equal(none.cut, true, "with no offset, a trimmed ring still says it was cut");
  assert.equal(none.from, r.start);
  for (const bad of [-1, 1.5, "abc", null]) assert.equal(r.since(/** @type {any} */ (bad)).from, r.start);
  // A fresh ring with no offset is not cut.
  const f = new Ring(1024); f.push(B("hi"));
  assert.equal(f.since(null).cut, false);
});

test("ring: a drop ends just after a newline, so a replay starts at a line", () => {
  const r = new Ring(1024);
  // Lines of 100 bytes, numbered, pushed in odd-sized chunks.
  let all = "";
  for (let i = 0; i < 40; i++) all += String(i).padStart(3, "0") + "-".repeat(96) + "\n";
  const buf = B(all);
  for (let i = 0; i < buf.length; i += 37) r.push(buf.subarray(i, i + 37));
  assert.equal(r.end, 4000);
  assert.ok(r.bytes <= 1024);
  const got = r.since(null).bytes.toString();
  assert.equal(r.start % 100, 0, `start ${r.start} is not a line start`);
  assert.match(got, /^\d{3}-/);
  assert.ok(all.endsWith(got));
  // Exact offsets inside the ring still line up with the original stream.
  const mid = r.start + 150;
  assert.equal(r.since(mid).bytes.toString(), all.slice(mid));
});

test("ring: with no newline in reach it drops exactly what it must, and never everything", () => {
  const r = new Ring(1024);
  r.push(B("a".repeat(3000)));
  assert.equal(r.bytes, 1024);
  assert.equal(r.start, 3000 - 1024);
  assert.equal(r.since(r.start).bytes.toString(), "a".repeat(1024));
  // A newline too far past the cut point (beyond the 64 KB look-ahead) is not waited for.
  const MB = 1024 * 1024;
  const big = new Ring(MB);
  big.push(Buffer.alloc(MB, 0x61));
  big.push(B("b".repeat(100 * 1024) + "\n" + "b".repeat(10)));
  assert.equal(big.bytes, MB);
  // One within reach is: the drop goes on to just after it.
  const near = new Ring(MB);
  near.push(B("a".repeat(200) + "\n" + "a".repeat(MB - 201)));
  near.push(B("b".repeat(100)));
  assert.equal(near.start, 201);
  assert.equal(near.bytes, MB + 100 - 201);
  // One chunk bigger than the ring that ends in a newline keeps its newest byte at least.
  const nl = new Ring(1024);
  nl.push(B("c".repeat(2000) + "\n"));
  assert.ok(nl.bytes >= 1 && nl.bytes <= 1024);
  assert.equal(nl.end, 2001);
});

test("ring: default cap is 1 MB, and a tiny cap is raised to 1 KB", () => {
  assert.equal(new Ring(/** @type {any} */ (undefined)).cap, 1024 * 1024);
  assert.equal(new Ring(10).cap, 1024);
});

test("wire: frame is type, 4-byte big-endian length, payload; JSON, strings and bytes", () => {
  const f = frame(T.IN, "ls\n");
  assert.equal(f[0], T.IN);
  assert.equal(f.readUInt32BE(1), 3);
  assert.equal(f.subarray(5).toString(), "ls\n");
  const j = frame(T.HELLO, { mode: "attach", from: 7 });
  assert.deepEqual(json(j.subarray(5)), { mode: "attach", from: 7 });
  const b = frame(T.OUT, Buffer.from([0, 255, 10]));
  assert.deepEqual([...b.subarray(5)], [0, 255, 10]);
  assert.equal(json(B("not json")), null);
});

test("wire: a Reader rebuilds frames from a stream split anywhere", () => {
  const frames = [frame(T.HELLO, { mode: "control" }), frame(T.OUT, B("x".repeat(1000))), frame(T.IN, B("")), frame(T.QUERY, "")];
  const stream = Buffer.concat(frames);
  for (const step of [1, 2, 3, 5, 7, 64, stream.length]) {
    const rd = new Reader();
    const got = [];
    for (let i = 0; i < stream.length; i += step) got.push(...rd.push(stream.subarray(i, i + step)));
    assert.equal(got.length, 4, `step ${step}`);
    assert.deepEqual(got.map(g => g.type), [T.HELLO, T.OUT, T.IN, T.QUERY]);
    assert.deepEqual(json(got[0].body), { mode: "control" });
    assert.equal(got[1].body.toString(), "x".repeat(1000));
    assert.equal(got[2].body.length, 0);
  }
});

test("wire: a frame claiming more than 4 MB is a broken peer", () => {
  const rd = new Reader();
  const head = Buffer.alloc(5); head[0] = T.OUT; head.writeUInt32BE(5 * 1024 * 1024, 1);
  assert.throws(() => rd.push(head), /too large/);
});

test("wire: output is split into OUT frames of at most MAX_FRAME", () => {
  assert.equal(outFrames(Buffer.alloc(0)).length, 0);
  assert.equal(outFrames(B("hi")).length, 1);
  const big = Buffer.alloc(MAX_FRAME * 2 + 10, 0x61);
  const fs = outFrames(big);
  assert.equal(fs.length, 3);
  assert.deepEqual(fs.map(f => f.readUInt32BE(1)), [MAX_FRAME, MAX_FRAME, 10]);
  assert.ok(fs.every(f => f[0] === T.OUT));
  const rd = new Reader();
  const back = Buffer.concat(rd.push(Buffer.concat(fs)).map(f => f.body));
  assert.ok(back.equals(big));
});
