// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelay } from "../../relay/node/server.js";
import { relayLink } from "./link.js";
import { newRouteKey, routeId } from "./wire.js";
import { keyPair } from "./noise.js";

const until = async (/** @type {() => any} */ f, ms = 5000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); } };

test("a control link that drops says how long it had been up and what it was told, in one log line (so a flap shows its own cause)", async t => {
  const relay = createRelay();
  const url = await relay.listen();
  const lines = /** @type {string[]} */ ([]);
  const rk = newRouteKey();
  const link = relayLink({ url, route: routeId(rk.pub), routeKey: rk, boxKey: keyPair(), admit: async () => { throw new Error("no devices"); }, onchannel: () => {}, log: m => lines.push(m), pingMs: 60_000 });
  t.after(() => link.stop());
  assert.equal(await link.ready(5000), true);
  await relay.close();
  const line = await until(() => lines.find(l => /control link closed after \d+ s up/.test(l)));
  assert.match(line, /code \d+/);
});
