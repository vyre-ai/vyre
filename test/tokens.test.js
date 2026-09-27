// The one-app tokens: one JSON, rendered for the Capsule (Swift), the app (TS) and the Deck (CSS).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load, swift, ts, css, rgba } from "../scripts/lib/tokens.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const t = load(ROOT);

test("tokens: both themes name the same colour roles", () => {
  assert.deepEqual(Object.keys(t.color.dark), Object.keys(t.color.paper));
  for (const theme of ["dark", "paper"]) for (const v of Object.values(t.color[theme])) rgba(v);
});

test("tokens: the status keys are the stable contract, most urgent first", () => {
  assert.deepEqual(t.status.order, ["needsYou", "failed", "running", "unread", "done"]);
  for (const k of t.status.order) assert.ok(t.status[k].word, k);
});

test("tokens: the Swift file carries every role, the status list in order, and mono sizes", () => {
  const s = swift(t);
  for (const k of Object.keys(t.color.dark)) assert.match(s, new RegExp(`public let ${k}: Color`));
  const order = [...s.matchAll(/Status\(key: "(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(order, t.status.order);
  assert.match(s, /monoSizes: \[CGFloat\] = \[12, 13\]/);
  assert.match(s, /beacon: Color\(\.sRGB, red: 184 \/ 255, green: 164 \/ 255, blue: 255 \/ 255, opacity: 1\)/);
  assert.equal(swift(t), s, "stable output");
});

test("tokens: the CSS uses the Deck's selectors and role names", () => {
  const c = css(t);
  assert.match(c, /^:root \{/m);
  assert.match(c, /^:root\[data-theme="paper"\] \{/m);
  for (const name of ["--bg:", "--panel:", "--hover:", "--text-2:", "--label:", "--rule-strong:", "--primary-bg:", "--primary-ink:",
    "--focus:", "--signal-wash:", "--code-bg:", "--beacon-ink:", "--beacon-dot:", "--beacon-badge-ink:", "--sans:", "--mono:", "--popover:", "--float:", "--radius-card:", "--radius-sheet:",
    "--size-base:", "--line-read:", "--space-4:", "--control-touch:", "--motion-panel:", "--ease:"])
    assert.ok(c.includes(name), name);
  assert.match(c, /@media \(max-width: 719px\), \(max-height: 500px\) and \(pointer: coarse\) \{\n  :root \{\n    --size-read: 17px; --line-read: 24px;/);
});

test("tokens: the TS file is what the app imports: tokens, Scheme, Colors, attention()", () => {
  const out = ts(t);
  assert.match(out, /export const tokens = /);
  assert.match(out, /export type Scheme = "dark" \| "paper";/);
  assert.match(out, /export type Colors = /);
  assert.match(out, /export function attention\(/);
  assert.doesNotMatch(out, /\$schema/);
});

test("tokens: every generated file in the tree is current", async () => {
  const { generate } = await import("../scripts/gen-tokens");
  for (const [rel, body] of Object.entries(generate())) {
    const file = path.join(ROOT, rel);
    if (fs.existsSync(file)) assert.equal(fs.readFileSync(file, "utf8"), body, `${rel} is stale; run npm run tokens`);
  }
});

test("tokens: every output names the root folder that must exist before it is written", async () => {
  const { OUTPUTS, ROOTS } = await import("../scripts/gen-tokens");
  for (const rel of Object.keys(OUTPUTS)) {
    assert.ok(ROOTS[rel], rel);
    assert.ok(rel.startsWith(ROOTS[rel] + "/"), `${rel} is under ${ROOTS[rel]}`);
  }
});
