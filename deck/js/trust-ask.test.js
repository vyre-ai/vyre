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
const { grouped, claimed, askOf, trustCard, watchTrustAsks, waitingOf, loadAsks } = await import("./trust-ask.js");
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const settle = () => new Promise(r => setTimeout(r, 10));

test("grouped and claimed: the fingerprint in fours, the name capped at 64 with no control characters", () => {
  assert.equal(grouped("ABCD1234EFGH5678"), "ABCD 1234 EFGH 5678");
  assert.equal(claimed("x".repeat(100)).length, 64);
  assert.equal(claimed("Alex\u0007's\nlaptop"), "Alex 's laptop");
  assert.equal(claimed("Kit\u202eevil\u202c\u200b\u2066x\u2069\ufeff\u0085ok"), "Kit evil x ok", "bidi, zero-width and C1 controls are taken out");
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
  assert.deepEqual(calls.find(c => c.tool === "relay.devices.trust"), { tool: "relay.devices.trust", input: { id: "d1", trusted: true } });
});

test("waitingOf reads the browsers your server lists as waiting (web, not trusted, trustAsked), name as its claim", () => {
  const list = { devices: [{ id: "w1", kind: "web", name: "Kit\u202e's Chrome", trusted: false, trustAsked: 1700000000000, fingerprint: "ab12 cd34" },
    { id: "w2", kind: "web", name: "Trusted", trusted: true, trustAsked: 5 }, { id: "w3", kind: "web", name: "Never asked", trusted: false }, { id: "p1", kind: "app", name: "Phone", trustAsked: 5 }] };
  assert.deepEqual(waitingOf(list), [{ id: "w1", name: "Kit 's Chrome", fingerprint: "ab12 cd34", asked: 1700000000000 }]);
  assert.deepEqual(waitingOf(null), []);
});

test("an ask your server lists after a reload still shows; with no key on the row Trust is off and the card says why", async () => {
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    calls.push({ tool, input: JSON.parse(o.body) });
    const data = tool === "relay.devices.list" ? { devices: [{ id: "w9", kind: "web", name: "Late laptop", trusted: false, trustAsked: Date.now() - 600000 }] } : {};
    return { status: 200, statusText: "", json: async () => ({ data }) };
  });
  await loadAsks();
  let shown = /** @type {any} */ (null);
  const stop = watchTrustAsks(el => { shown = el; });
  assert.ok(shown, "an ask waits until it is acted on");
  assert.match(text(shown), /Late laptop/);
  assert.match(text(shown), /key is not shown after a reload/);
  assert.equal($(shown, "[data-act=trust]").disabled, true);
  assert.equal($(shown, "[data-fp]"), null);
  stop();
});
