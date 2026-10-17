import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith("dist") || e.name === ".expo" || e.name === "public") continue;
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

// The owner's rule: no standard QR anywhere a person shares or pairs. The vault's encoder (core/vault/qr.js) may be reached only from the vault's own screens (the 2FA camera use), never from an invite or a first-run screen.
test("nothing outside the vault's screens imports core/vault/qr.js", () => {
  const bad = [];
  for (const f of files(root)) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    if (rel.startsWith("screens/vault/") || rel.startsWith("modules/")) continue;
    if (/vault\/qr(\.js)?["']/.test(fs.readFileSync(f, "utf8"))) bad.push(rel);
  }
  assert.deepEqual(bad, []);
});

test("the invite share draws no code, only the link with Copy and Share", () => {
  const s = fs.readFileSync(path.join(root, "ui/components/InviteShare.tsx"), "utf8");
  assert.doesNotMatch(s, /invite-mark|inviteModules|Invite mark/);
  assert.match(s, /label="Share"/);
});
