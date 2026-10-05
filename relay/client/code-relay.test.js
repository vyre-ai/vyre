// @ts-check
// The typed code end to end: a typing device (enterCode) through the Node relay, to a box's link
// (core/relay/link.js) running the showing device's state machine (core/wink/code.js).

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../node/server.js";
import { relayLink } from "../../core/relay/link.js";
import { newRouteKey, routeId } from "../../core/relay/wire.js";
import { keyPair } from "../../core/relay/noise.js";
import { createWinkCode } from "../../core/wink/code.js";
import { enterCode, toHex, ackCode } from "./code.js";

async function world(t, relayOpts = {}) {
  const relay = createRelay({ clientAddress: req => String(req.headers["x-test-ip"] || "127.0.0.1"), ...relayOpts });
  const base = await relay.listen();
  t.after(() => relay.close());
  const routeKey = newRouteKey(), route = routeId(routeKey.pub);
  /** @type {any} */
  let wink = null;
  const events = [];
  const link = relayLink({
    url: base, route, routeKey, boxKey: keyPair(), admit: async () => ({ ok: true }), onchannel: () => {},
    oncode: msg => link.codeReply(msg.q, wink.handle(msg)?.m ?? null),
  });
  t.after(() => link.stop());
  assert.equal(await link.ready(3000), true);
  assert.equal(link.codes(), true, "the relay says it has the typed-code rendezvous");
  wink = createWinkCode({ route, allocate: () => link.codeAlloc(), release: () => link.codeRelease(), emit: (n, d) => events.push([n, d]) });
  const shown = /** @type {any} */ (await wink.open());
  return { relay, ws: base, base: base.replace(/^ws/, "http"), route, wink, events, shown, link };
}

test("typed code end to end: the typist enters the code, the person types back the typist's code, the keys match", async t => {
  const w = await world(t);
  const typed = w.shown.code.toLowerCase().replace(/-/g, " ");
  const r = await enterCode({ base: w.base, input: typed });
  assert.equal(r.ok, true);
  const ok = /** @type {any} */ (r);
  assert.equal(ok.route, w.route);
  const ack = /** @type {any} */ (w.events.find(e => e[0] === "wink.code.ack"))[1];
  const done = await w.wink.ack(ack.id, ackCode(ok.key));
  assert.equal(done.ok, true);
  assert.equal(toHex(/** @type {any} */ (done).key), toHex(ok.key));
  // Single use: the same code again answers like any dead code.
  assert.deepEqual(await enterCode({ base: w.base, input: w.shown.code }), { ok: false, reason: "refused" });
});

test("typed code end to end: a wrong code is refused with the one generic answer, and an unknown rendezvous gets the same", async t => {
  const w = await world(t);
  const pw = w.shown.code.slice(-4) === "0000" ? "1111" : "0000";
  const wrong = await enterCode({ base: w.base, input: `${w.shown.code.slice(0, 10)}${pw}` });
  assert.deepEqual(wrong, { ok: false, reason: "refused" });
  const other = w.shown.rv === "ZZ" ? "ZY" : "ZZ";
  assert.deepEqual(await enterCode({ base: w.base, input: `WINK-${other}AB-CDEF`.replace("AB-CD", "ABCD") }), { ok: false, reason: "refused" });
  assert.deepEqual(await enterCode({ base: w.base, input: "hello!" }), { ok: false, reason: "format" });
  assert.equal(w.wink.status().attempts, 1, "the wrong code cost one attempt");
});

test("typed code end to end: ten sessions from many addresses close the code and a fresh one is showing", async t => {
  const w = await world(t);
  const first = w.shown.code;
  // Abandoned sessions: message 1 only, from ten addresses (so no per-address limit is what stops them).
  for (let i = 0; i < 10; i++) {
    await fetch(`${w.base}/v1/wink/code`, { method: "POST", headers: { "content-type": "application/json", "x-test-ip": `192.0.2.${i + 1}` },
      body: JSON.stringify({ rv: w.shown.rv, s: "AAAAAAAAAAAAAAAAAAAAAA".slice(0, 21) + "ABCDEFGHIJ"[i], n: 1, m: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" }) });
  }
  await new Promise(r => setTimeout(r, 100));
  assert.equal(/** @type {any} */ (w.events.find(e => e[0] === "wink.code.closed"))[1].reason, "too_many");
  const now = w.wink.status();
  assert.ok(now && now.code !== first, "a fresh code with no tap");
  assert.notEqual(now.rv, w.shown.rv);
});

test("the relay says the code's end: enterCode keeps `exp`, joinWithCode puts it in the ack state as `expires`, and the wait for the ack runs to it, not to five minutes", async t => {
  const { joinWithCode } = await import("./join.js");
  const { nodeCrypto, fileKeyStore } = await import("./nodecrypto.js");
  const { tempHome } = await import("../../test/helpers.js");
  const path = await import("node:path");
  const w = await world(t);
  const r = /** @type {any} */ (await enterCode({ base: w.base, input: w.shown.code }));
  assert.equal(r.ok, true);
  assert.equal(r.exp, w.shown.expires, "the relay's slot end is the code's end");
  assert.ok(r.exp - Date.now() > 9 * 60_000, "ten minutes");
  // a short-lived code (the relay's own ttl): the join gives up at the code's end, well before the old five-minute window
  const short = await world(t, { code: { ttl: 2500 } });
  /** @type {any[]} */ const states = [];
  const t0 = Date.now();
  const res = await joinWithCode({ relay: short.ws, input: short.shown.code, name: "Kit's laptop", pollMs: 100, onState: s => states.push(s), pairOptions: { crypto: nodeCrypto(), keyStore: fileKeyStore(path.join(tempHome(t), "k.json")) } });
  const ack = states.find(s => s.state === "ack");
  assert.ok(ack && Number.isFinite(ack.expires) && ack.expires > t0, "the ack state carries `expires`");
  assert.equal(res.ok, false);
  assert.ok(Date.now() - t0 < 8000, `it waited about the code's life (${Date.now() - t0} ms), not five minutes`);
});
