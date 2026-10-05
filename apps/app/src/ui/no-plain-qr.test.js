import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { winkCodeSvg, ringBytes, KINDS } from "./wink-code-source.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith("dist") || e.name === ".expo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out); else if (/\.(tsx?|jsx?|mjs)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

// ADR 0043: every code a person scans is a Wink code, the drawn avatar with its ring. A generic QR component or encoder never ships in a screen.
test("no screen renders or imports a generic QR component", () => {
  const bad = [];
  for (const f of files(root)) {
    const s = fs.readFileSync(f, "utf8");
    if (/qrcode|qr-code|QrCode|qrMatrix|relay\/client\/qr|react-native-qr/i.test(s.replace(/WinkCode/g, ""))) bad.push(path.relative(root, f));
  }
  assert.deepEqual(bad, []);
});

test("a Wink code is unique per ticket and the same for one ticket", () => {
  const a = winkCodeSvg("vyre://wink/2?t=AAAAAAAAAAAAAAAAAAAAAA&r=x");
  assert.equal(a, winkCodeSvg("vyre://wink/2?t=AAAAAAAAAAAAAAAAAAAAAA&r=x"));
  assert.notEqual(a, winkCodeSvg("vyre://wink/2?t=BBBBBBBBBBBBBBBBBBBBBB&r=x"));
  assert.ok(a.startsWith("<svg"));
  assert.equal(ringBytes("x").length, 8);
});

test("each kind says its own words", () => {
  assert.equal(KINDS.device.words(), "Add your device");
  assert.equal(KINDS.join.words("Harlow Legal"), "Join Harlow Legal");
});
