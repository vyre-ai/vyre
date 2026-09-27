// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { keyPair } from "./noise.js";
import { deviceSide, boxSide } from "./channel.js";
import { bridge } from "./bridge.js";

const ROUTE = "abcdefghijklmnopqrstuvwxyz";

async function pair() {
  const box = keyPair(), dev = keyPair();
  const ends = { device: /** @type {any} */ (null), box: /** @type {any} */ (null) };
  const mk = to => ({ send: bytes => setImmediate(() => ends[to]?.receive(Buffer.from(bytes))), close() {} });
  ends.box = boxSide(mk("device"), { s: box, route: ROUTE, admit: async () => ({ ok: true }) });
  ends.device = deviceSide(mk("box"), { s: dev, box: box.pub, route: ROUTE, hello: { v: 1 } });
  const [{ channel: device }, { channel: boxCh }] = await Promise.all([ends.device.ready, ends.box.ready]);
  return { device, boxCh };
}

test("the bridge passes Idempotency-Key and Last-Event-ID, and drops what a device may not set", async () => {
  const { device, boxCh } = await pair();
  /** @type {any[]} */
  const seen = [];
  bridge(boxCh, {
    caller: "device:kit",
    peer: {},
    handler: (req, res, caller) => {
      seen.push({ caller, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    },
  });
  const s = device.open({ method: "POST", path: "/v1/tools/threads.send", headers: {
    "idempotency-key": "8f14e45f-ceea-467a-9575-8f2b2d7e3a1c",
    "last-event-id": "42",
    "x-vyre-agent-key": "not yours",
    "content-type": "application/json",
  } });
  const status = new Promise(resolve => { s.onhead = h => resolve(h.status); });
  s.end();
  assert.equal(await status, 200);
  assert.equal(seen[0].caller, "device:kit");
  assert.equal(seen[0].headers["idempotency-key"], "8f14e45f-ceea-467a-9575-8f2b2d7e3a1c");
  assert.equal(seen[0].headers["last-event-id"], "42");
  assert.equal(seen[0].headers["x-vyre-agent-key"], undefined);
  device.close();
});
