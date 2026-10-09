// @ts-check
// RFC 6455 framing is written once, in lib/ws.js (consolidation inventory item 13). Voice's Peer and the relay bridge's client half are thin shapes over it; the computers image carries a generated copy.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, encodeClientFrame, FrameParser, acceptKey, upgradeHead } from "../lib/ws.js";
import { FrameParser as VoiceParser } from "../local/voice/ws.js";
import { clientFrame, ServerFrames, OP } from "../core/relay/wsclient.js";
import { findInSource } from "./source-files.js";

const ALLOWED = new Map([
  ["lib/ws.js", "the one framing"],
  ["core/computers/image/computerd/ws.js", "generated from lib/ws.js (scripts/sync-copies.mjs, test/generated-copies.test.js): the image is built from that folder alone"],
  ["local/hands-chrome-mac/standalone/harness/real.mjs", "a test harness that fakes a WebSocket server"],
]);
const PATTERNS = [/258EAFA5/, /Switching Protocols\\r\\nUpgrade: websocket/i, /header\[1\]\s*=\s*(?:0x80\s*\|\s*)?(?:bit\s*\|\s*)?12[67]/];

test("no other source file frames or handshakes a WebSocket of its own", () => {
  assert.deepEqual(findInSource(PATTERNS, ALLOWED), [], "use encodeFrame, FrameParser, acceptKey and upgradeHead from lib/ws.js");
});

test("both directions round-trip through the one framing, at every length class", () => {
  for (const n of [0, 5, 125, 126, 300, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(n, 7);
    const up = new FrameParser({ masked: true }).push(encodeFrame(payload, 2, true));
    assert.equal(up.length, 1); assert.ok(/** @type {any} */ (up[0]).message.equals(payload), `client to server, ${n}`);
    const down = new FrameParser({ masked: false }).push(encodeFrame(payload, 1));
    assert.equal(down.length, 1); assert.equal(/** @type {any} */ (down[0]).opcode, 1); assert.ok(/** @type {any} */ (down[0]).message.equals(payload), `server to client, ${n}`);
  }
  assert.throws(() => new FrameParser({ masked: true }).push(encodeFrame(Buffer.from("x"), 2)), /must be masked/);
  assert.throws(() => new FrameParser({ masked: false }).push(encodeFrame(Buffer.from("x"), 2, true)), /must not be masked/);
  assert.deepEqual([...encodeClientFrame(Buffer.from("hi"), 1, Buffer.from([1, 2, 3, 4]))], [...encodeFrame(Buffer.from("hi"), 1, Buffer.from([1, 2, 3, 4]))]);
});

test("a close frame carries its status code, and a message over the limit is refused", () => {
  const close = Buffer.alloc(2); close.writeUInt16BE(1001);
  const [e] = /** @type {any[]} */ (new FrameParser({ masked: false }).push(encodeFrame(close, 8)));
  assert.equal(e.control, "close"); assert.equal(e.code, 1001);
  assert.throws(() => new FrameParser({ masked: false, max: 100 }).push(encodeFrame(Buffer.alloc(200), 2)), /limit/);
  const p = new FrameParser({ masked: false, max: 100 });
  const half = Buffer.alloc(60);
  const first = encodeFrame(half, 2); first[0] &= 0x7f;   // fin off
  assert.throws(() => p.push(Buffer.concat([first, Buffer.from([0x80, 60]), half])), /over 100 bytes/);
});

test("the handshake answer is one string, with the protocol line when one is negotiated", () => {
  const head = upgradeHead("dGhlIHNhbXBsZSBub25jZQ==");
  assert.match(head, /^HTTP\/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n\r\n$/);
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.match(upgradeHead("k", "Sec-WebSocket-Protocol: binary\r\n"), /Sec-WebSocket-Protocol: binary\r\n\r\n$/);
});

test("voice's parser and the relay bridge's client half answer in their own shapes over the same bytes", () => {
  const v = new VoiceParser({ masked: true }).push(encodeFrame(Buffer.from("hello"), 1, true));
  assert.deepEqual(v, [{ text: "hello" }]);
  const b = new VoiceParser({ masked: false }).push(encodeFrame(Buffer.from([1, 2]), 2));
  assert.equal(b.length, 1); assert.deepEqual([.../** @type {any} */ (b[0]).binary], [1, 2]);
  const r = new ServerFrames().push(Buffer.concat([encodeFrame(Buffer.from("a"), OP.text), encodeFrame(Buffer.alloc(0), OP.ping)]));
  assert.deepEqual(r.map(x => x.op), [OP.text, OP.ping]);
  assert.ok(new FrameParser({ masked: true }).push(clientFrame(Buffer.from("z"), OP.binary)).length === 1);
  assert.throws(() => new ServerFrames().push(encodeFrame(Buffer.alloc((1 << 20) + 10), 2)), /too big for the relay/);
});
