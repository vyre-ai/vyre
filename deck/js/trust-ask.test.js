// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, { dispatchEvent: () => true });
const calls = /** @type {any[]} */ ([]);
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  calls.push({ tool, input: JSON.parse(o.body) });
  return { status: 200, statusText: "", json: async () => ({ data: { id: "d1", trusted: true } }) };
});
const { grouped, claimed, askOf, trustCard, watchTrustAsks } = await import("./trust-ask.js");
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const settle = () => new Promise(r => setTimeout(r, 10));

test("grouped and claimed: the fingerprint in fours, the name capped at 64 with no control characters", () => {
  assert.equal(grouped("ABCD1234EFGH5678"), "ABCD 1234 EFGH 5678");
  assert.equal(claimed("x".repeat(100)).length, 64);
  assert.equal(claimed("Alex\u0007's\nlaptop"), "Alex 's laptop");
  assert.equal(askOf({ id: "", fingerprint: "x" }), null);
  assert.equal(askOf({ id: "d1" }), null, "no fingerprint, no prompt");
  assert.deepEqual(askOf({ id: "d1", name: "  Kit's Chrome ", fingerprint: "AB" }), { id: "d1", name: "Kit's Chrome", fingerprint: "AB" });
});

test("the card puts the key first in mono and labels the name 'says it is', as the browser's own claim", () => {
  const c = trustCard({ id: "d1", name: "Alex's laptop", fingerprint: "ABCD1234EFGH5678" });
  const t = text(c);
  assert.ok(t.indexOf("ABCD 1234 EFGH 5678") < t.indexOf("says it is"), "the key comes before the name");
  assert.match(t, /It says it is "Alex's laptop"\. That name is the browser's own claim/);
  assert.equal($(c, "[data-fp]").className.includes("code"), true);
  assert.match(text(trustCard({ id: "d2", name: "", fingerprint: "AB" })), /\(no name\)/);
});

test("Trust calls relay.devices.trust {id, trusted: true} with the person's presence; Not now sets it aside", async () => {
  calls.length = 0;
  let shown = /** @type {any} */ (null);
  const stop = watchTrustAsks(el => { shown = el; });
  assert.equal(shown, null, "nothing pending, nothing shown");
  stop();
  const c = trustCard({ id: "d1", name: "Kit", fingerprint: "AB12" });
  click($(c, "[data-act=trust]")); await settle();
  assert.deepEqual(calls[0], { tool: "relay.devices.trust", input: { id: "d1", trusted: true } });
});
