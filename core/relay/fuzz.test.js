// @ts-check
// The relay's frames come from a phone or whoever holds a paired key: whatever they send, the
// box's channel closes or ignores it and never throws.
import test from "node:test";
import assert from "node:assert/strict";
import { keyPair } from "./noise.js";
import { deviceSide, boxSide, FRAME } from "./channel.js";
import { rng, junk } from "../../test/fuzz.js";

const ROUTE = "abcdefghijklmnopqrstuvwxyz";
const settle = () => new Promise(r => setTimeout(r, 30));

async function pair() {
  const box = keyPair(), dev = keyPair();
  const ends = { device: /** @type {any} */ (null), box: /** @type {any} */ (null) };
  const closes = /** @type {any[]} */ ([]);
  const mk = (/** @type {string} */ from, /** @type {string} */ to) => ({
    send(/** @type {Buffer} */ bytes) { const b = Buffer.from(bytes); setImmediate(() => ends[to]?.receive(b)); },
    close(/** @type {number} */ code, /** @type {string} */ reason) { closes.push({ from, code, reason }); },
  });
  const b = boxSide(mk("box", "device"), { s: box, route: ROUTE, admit: async () => ({ ok: true }) });
  ends.box = b;
  const d = deviceSide(mk("device", "box"), { s: dev, box: box.pub, route: ROUTE, hello: { v: 1, name: "alex's phone" } });
  ends.device = d;
  const [{ channel: dch }, { channel: bch }] = await Promise.all([d.ready, b.ready]);
  return { dch, bch, closes };
}

test("relay fuzz: garbage bytes never throw in the box's channel and close it", async () => {
  const r = rng(11);
  for (let i = 0; i < 200; i++) {
    const { bch, closes } = await pair();
    assert.doesNotThrow(() => bch.receive(r.bytes(r.int(200))));
    assert.equal(bch.closed, true);
    assert.equal(closes.at(-1).code, 4400);
  }
});

test("relay fuzz: authentic frames with hostile types, ids, heads and data never throw", async () => {
  const r = rng(12);
  const { dch, bch } = await pair();
  const seen = { streams: 0 };
  bch.onstream = s => { seen.streams++; s.onhead = () => {}; s.ondata = () => {}; s.onend = () => {}; s.onreset = () => {}; };
  const types = [...Object.values(FRAME), 0, 7, 255];
  for (let i = 0; i < 2000 && !bch.closed; i++) {
    const type = r.pick(types), id = r.pick([0, 1, 2, 3, r.int(2 ** 32), 4294967295]);
    const payload = r.pick([
      Buffer.alloc(0), r.bytes(r.int(64)), Buffer.from(JSON.stringify(junk(r))), Buffer.from("{"), Buffer.from("null"), Buffer.from("[1"),
    ]);
    dch.frame(type, id, payload);
    if (i % 100 === 0) await settle();
  }
  await settle();
  assert.ok(bch.streams.size <= 2000, "streams the peer opened are bounded by what it sent");
});
