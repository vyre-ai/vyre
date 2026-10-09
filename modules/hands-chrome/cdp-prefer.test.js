// @ts-check
// The tab a Vault sign-in earned a session in is the tab the hands work in next (R031-93), and a tab attached to belongs to the socket that closes.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Cdp, CdpPool } from "./cdp.js";

/** A Cdp whose browser is a list of tabs. */
function fakeCdp(tabs) {
  const c = new Cdp({ cdpUrl: "http://127.0.0.1:1" });
  /** @type {string[]} */ const attached = [];
  c.connect = async () => {};
  c.send = async (method, params) => {
    if (method === "Target.getTargets") return { targetInfos: tabs };
    if (method === "Target.attachToTarget") { attached.push(params.targetId); return { sessionId: `s-${params.targetId}` }; }
    return {};
  };
  return { c, attached };
}

test("a preferred tab is attached first; without it the first web page is", async () => {
  const tabs = [{ type: "page", targetId: "A", url: "https://old.example/" }, { type: "page", targetId: "B", url: "https://signed-in.example/home" }];
  const plain = fakeCdp(tabs);
  assert.equal(await plain.c.page(), "s-A");
  const pref = fakeCdp(tabs);
  pref.c.prefer = "B";
  assert.equal(await pref.c.page(), "s-B");
  const gone = fakeCdp(tabs);
  gone.c.prefer = "Z";
  assert.equal(await gone.c.page(), "s-A", "a tab that is gone is not waited for");
});

test("the pool remembers a preferred tab for a connection not made yet, and re-attaches on a live one", async () => {
  const pool = new CdpPool({});
  pool.prefer("kit", "B");
  assert.equal(pool.wanted.get("kit"), "B");
  const { c } = fakeCdp([{ type: "page", targetId: "A", url: "https://a.example/" }, { type: "page", targetId: "B", url: "https://b.example/" }]);
  c.sessionId = "s-A";
  pool.byAgent.set("kit", c);
  pool.prefer("kit", "B");
  assert.equal(c.sessionId, null, "the old attachment is dropped");
  assert.equal(c.prefer, "B");
});

test("a closed socket forgets the tab it was attached to", () => {
  const c = new Cdp({ cdpUrl: "http://127.0.0.1:1" });
  c.sessionId = "s-1";
  c._onClose();
  assert.equal(c.sessionId, null);
});
