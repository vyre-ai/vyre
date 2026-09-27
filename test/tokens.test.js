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

test("tokens: the CSS uses the Deck's role names", () => {
  const c = css(t);
  for (const name of ["--bg:", "--text-2:", "--rule-strong:", "--primary-bg:", "--signal-wash:", "--code-bg:"]) assert.ok(c.includes(name), name);
});

test("tokens: the TS file is plain values", () => {
  const out = ts(t);
  assert.match(out, /export const tokens = /);
  assert.doesNotMatch(out, /\$schema/);
});

test("tokens: a generated file in the tree is current", () => {
  const file = path.join(ROOT, "local/capsule/native/Sources/UI/Tokens.generated.swift");
  if (!fs.existsSync(file)) return;
  assert.equal(fs.readFileSync(file, "utf8"), swift(t), "run scripts/gen-tokens");
});
