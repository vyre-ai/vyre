// @ts-check
// The Capsule's Swift tokens come from the one tokens.json: every colour key in both schemes, the
// status rows in order with their words, and the file on disk is what gen-tokens writes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, tokensSwift, swiftColor, SOURCE, SWIFT_OUT } from "../scripts/gen-tokens";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(fs.readFileSync(path.join(REPO, SOURCE), "utf8"));

test("tokens-swift: the committed Swift file is what gen-tokens writes", () => {
  assert.equal(fs.readFileSync(path.join(REPO, SWIFT_OUT), "utf8"), generate()[SWIFT_OUT], `${SWIFT_OUT} is stale; run node scripts/gen-tokens`);
});

test("tokens-swift: colours are exact sRGB components, and anything else is refused", () => {
  assert.equal(swiftColor("#B8A4FF"), "Color(.sRGB, red: 184 / 255, green: 164 / 255, blue: 255 / 255, opacity: 1)");
  assert.equal(swiftColor("rgba(198,243,107,0.12)"), "Color(.sRGB, red: 198 / 255, green: 243 / 255, blue: 107 / 255, opacity: 0.12)");
  assert.throws(() => swiftColor("coral"));
});

test("tokens-swift: both schemes carry every colour key, and the status rows keep their order and words", () => {
  const swift = tokensSwift(tokens);
  for (const k of Object.keys(tokens.color.dark)) {
    assert.match(swift, new RegExp(`public let ${k}: Color`));
    assert.equal(swift.split(`\n        ${k}: Color(`).length - 1, 2, `${k} in dark and paper`);
  }
  const words = [...swift.matchAll(/Status\(key: "(\w+)".*word: "([^"]+)"\)/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(words, tokens.status.order.map(k => [k, tokens.status[k].word]));
  assert.doesNotMatch(swift, /coral|#FF6B4A|#E8573A/i);
});

test("tokens-swift: a scheme missing a key is an error, not a silent gap", () => {
  const t = structuredClone(tokens);
  delete t.color.paper.beacon;
  assert.throws(() => tokensSwift(t), /color\.paper has no beacon/);
});
