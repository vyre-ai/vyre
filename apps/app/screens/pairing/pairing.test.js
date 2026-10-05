// @ts-check
// The pairing card on Now (the Deck's pair.js, ported) over a fake box: requests listed, the typed code, refusals, Deny, expiry, and nothing when none wait.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const NOW = 1_000_000;
const row = (/** @type {any} */ o = {}) => ({ id: "r1", name: "Office laptop", login: "sam", node: "laptop", kind: "mac", created: NOW - 60_000, expires: NOW + 9 * 60_000, ...o });

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return typeof o[tool] === "function" ? o[tool](input) : o[tool];
    return { error: { code: "not_found", message: `no ${tool}` } };
  };
  return { call, seen };
}

test("a request is listed with its computer and minutes left, oldest first, and junk is dropped", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const rs = m.requestsOf([row({ id: "b", expires: NOW + 5 * 60_000 }), row({ id: "a", expires: NOW + 2 * 60_000 }), null, { name: "x" }]);
  assert.deepEqual(rs.map((r) => r.id), ["a", "b"]);
  assert.equal(rs[0].sub, "laptop \u00b7 sam");
  assert.equal(m.leftLine(rs[0].expires, NOW), "2 min left");
  assert.deepEqual(m.requestsOf({ not: "a list" }), []);
});

test("the card is gone when none are good: expired and answered requests drop out", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const rs = m.requestsOf([row({ id: "old", expires: NOW - 1 }), row({ id: "ok" }), row({ id: "paired" })]);
  assert.deepEqual(m.visible(rs, NOW, new Set(["paired"])).map((r) => r.id), ["ok"]);
  assert.deepEqual(m.visible(m.requestsOf([row({ id: "old", expires: NOW - 1 })]), NOW), []);
  assert.equal(m.leftLine(NOW - 5, NOW), "Expired");
});

test("the code is typed: six digits, shaped 123-456, Approve stays off until all six are in", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.equal(m.shape("123456"), "123-456");
  assert.equal(m.shape("12a3-4"), "123-4");
  assert.equal(m.shape("1234567890"), "123-456");
  assert.equal(m.canApprove("123-45"), false);
  assert.equal(m.canApprove("123-456"), true);
});

test("approve sends the digits only, and the person's passkey is the door's job", { skip: !strip }, async () => {
  const { pairingSource } = await import("./source.ts");
  const b = box({ "link.pair.approve": { data: { peer: "p1", name: "Office laptop" } } });
  const r = await pairingSource(b.call).approve("123456");
  assert.equal(r.name, "Office laptop");
  assert.deepEqual(b.seen, [{ tool: "link.pair.approve", input: { code: "123456" } }]);
});

test("a wrong code and the retry limit are said in words that say what to do", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const { pairingSource } = await import("./source.ts");
  const b = box({ "link.pair.approve": { error: { code: "error", message: "no pairing request has that code (it may have expired)" } } });
  /** @type {any} */ let err;
  await pairingSource(b.call).approve("999999").catch((e) => { err = e; });
  assert.match(m.pairSay(err), /does not match/);
  assert.match(m.pairSay({ message: "too many wrong codes; every pairing request was cancelled, start again from the Mac" }), /Too many wrong codes.*cancelled.*Start again/);
  assert.match(m.pairSay({ message: "approve with your passkey (Touch ID on this Mac...)" }), /passkey/);
  assert.match(m.pairSay({ code: "cancelled", message: "" }), /Nothing was paired/);
});

test("deny sends the request id and says it was refused", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const { pairingSource } = await import("./source.ts");
  const b = box({ "link.pair.deny": { data: { ok: true } } });
  await pairingSource(b.call).deny("r1");
  assert.deepEqual(b.seen, [{ tool: "link.pair.deny", input: { id: "r1" } }]);
  assert.equal(m.deniedLine("Mac"), "Refused. Mac was told no.");
  assert.match(m.pairedLine("Mac"), /^Mac is paired/);
});

test("a box without pairing, or one that errors, has no requests and no card", { skip: !strip }, async () => {
  const { pairingSource } = await import("./source.ts");
  const b = box();
  assert.deepEqual(await pairingSource(b.call).pending(), []);
  assert.equal(await pairingSource(b.call).winkAsk(), null);
});

test("link.pending is read as listed, and a new device asking over Wink shows its three words", { skip: !strip }, async () => {
  const { pairingSource } = await import("./source.ts");
  const m = await import("./model.ts");
  const b = box({ "link.pending": { data: [row()] }, "wink.phone.pairing": { data: { asking: true, name: "Sam's iPhone", words: ["Maple", "River", "Stone"] } } });
  const s = pairingSource(b.call);
  assert.equal((await s.pending()).length, 1);
  assert.deepEqual(await s.winkAsk(), { name: "Sam's iPhone", words: ["maple", "river", "stone"] });
  assert.equal(m.winkAsking({ asking: false }), null);
  assert.equal(m.winkAsking({ asking: true, words: ["one", "two"] }), null);
});

test("the events that redraw the card are the pairing ones", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  for (const t of ["link.pair-requested", "link.paired", "wink.phone.pairing"]) assert.ok(m.PAIR_EVENTS.test(t), t);
  assert.ok(!m.PAIR_EVENTS.test("tasks.created"));
});

test("the words follow the phone rule: no server, installer or terminal talk", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const all = [m.EXPIRED, m.APPROVING, m.pairedLine("Mac"), m.deniedLine("Mac"), m.pairSay({ message: "no pairing request has that code" }), m.pairSay({ message: "too many wrong codes" }), m.pairSay({ message: "cannot approve its own" }), m.pairSay({ code: "no_passkey", message: "" })].join(" ");
  assert.doesNotMatch(all, /server|install|terminal|vyre link|command/i);
});
