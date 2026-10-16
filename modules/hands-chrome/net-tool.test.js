// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { watchNetwork } from "./net-tool.js";

test("watchNetwork: records request URLs without query strings", async () => {
  /** @type {any[]} */
  const sent = [];
  const cdp = {
    on: (fn) => { cdp._fn = fn; return () => {}; },
    send: async (method, params, sessionId) => { sent.push({ method, sessionId }); return {}; },
    _fn: null,
  };
  const w = watchNetwork(cdp, "s1");
  await w.start();
  assert.equal(sent[0].method, "Network.enable");
  cdp._fn({ method: "Network.requestWillBeSent", sessionId: "s1", params: { request: { method: "GET", url: "https://app.example.com/path?secret=1" }, type: "Fetch" } });
  const list = w.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].url, "https://app.example.com/path");
  w.stop();
});
