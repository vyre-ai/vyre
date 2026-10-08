// @ts-check
// The pairing card on Now over a fake box: a new device asking over Wink shows its three words, and nothing shows when none is asking.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

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

test("a new device asking over Wink shows its three words, lowercased, and its name", { skip: !strip }, async () => {
  const { pairingSource } = await import("./source.ts");
  const b = box({ "wink.phone.pairing": { data: { asking: true, name: "Sam's iPhone", words: ["Maple", "River", "Stone"] } } });
  assert.deepEqual(await pairingSource(b.call).winkAsk(), { name: "Sam's iPhone", words: ["maple", "river", "stone"] });
  assert.deepEqual(b.seen, [{ tool: "wink.phone.pairing", input: {} }]);
});

test("words may arrive as one string, and a nameless request is called a new device", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.winkAsking({ asking: true, words: "Maple River Stone" }), { name: "A new device", words: ["maple", "river", "stone"] });
});

test("nothing is asking, or the words are not three: no card", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.equal(m.winkAsking({ asking: false }), null);
  // the server's own answer has no words (the person types the ones the new device shows): still asking
  assert.deepEqual(m.winkAsking({ asking: true, name: "Sam's phone", choices: ["a b c"], line: "?" }), { name: "Sam's phone", words: null });
  assert.deepEqual(m.winkAsking({ asking: true, words: ["one", "two"] }), { name: "A new device", words: null });
  assert.equal(m.winkAsking({ asking: true, words: ["one", "", "three"] }), null);
  assert.equal(m.winkAsking(null), null);
});

test("a box without Wink pairing, or one that errors, has no request and no card", { skip: !strip }, async () => {
  const { pairingSource } = await import("./source.ts");
  assert.equal(await pairingSource(box().call).winkAsk(), null);
  const bad = box({ "wink.phone.pairing": () => { throw new Error("down"); } });
  assert.equal(await pairingSource(bad.call).winkAsk(), null);
});

test("only wink events redraw the card, and the link tools are not used", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.ok(m.PAIR_EVENTS.test("wink.phone.pairing"));
  assert.ok(!m.PAIR_EVENTS.test("link.paired"));
  assert.ok(!m.PAIR_EVENTS.test("tasks.created"));
  const fs = await import("node:fs");
  const dir = new URL(".", import.meta.url);
  for (const f of ["model.ts", "source.ts", "PairingCards.tsx"]) assert.doesNotMatch(fs.readFileSync(new URL(f, dir), "utf8"), /link\.(pending|pair)/, f);
});

test("the words follow the phone rule: no server, installer or terminal talk", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const all = [m.pairedLine("Mac"), m.notPairedLine("Mac")].join(" ");
  assert.match(m.pairedLine("Mac"), /^Mac is paired/);
  assert.doesNotMatch(all, /server|install|terminal|vyre link|command/i);
});
