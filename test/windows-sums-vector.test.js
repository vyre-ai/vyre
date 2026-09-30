// @ts-check
// The Windows app's Rust updater and vyre-core's verifySums must agree on the same signed
// SHA256SUMS bytes: this pins the fixture the Rust tests read.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifySums, RELEASE_KEY } from "../core/vyre-core/release.js";

const v = JSON.parse(fs.readFileSync(new URL("../local/capsule/native-win/tests/sums-vector.json", import.meta.url), "utf8"));

test("windows sums vector: verifySums accepts it and refuses a changed byte", () => {
  const m = verifySums(v.sums, v.sig, { key: v.key });
  assert.equal(m.get("Vyre_0.2.0_x64-setup.exe"), "aa".repeat(32));
  assert.throws(() => verifySums(v.sums.replace("aa", "ab"), v.sig, { key: v.key }), /does not verify/);
});

test("windows updater pins the same release key as vyre-core", () => {
  const rs = fs.readFileSync(new URL("../local/capsule/native-win/src/update.rs", import.meta.url), "utf8");
  assert.ok(rs.includes(`"${RELEASE_KEY}"`), "update.rs RELEASE_KEY matches release.js");
});

import { ticketOpen, ticketMac, ticketDerive } from "../core/relay/wire.js";

test("windows wink vector: the box-side code opens what the Rust reader is tested against", () => {
  const w = JSON.parse(fs.readFileSync(new URL("../local/capsule/native-win/tests/wink-vector.json", import.meta.url), "utf8"));
  const ticket = Buffer.from(w.ticket, "hex");
  assert.equal(ticketDerive("loc", ticket).toString("base64url"), w.loc);
  assert.equal(ticketMac(ticket, w.record).toString("base64url"), w.mac);
  assert.equal(JSON.parse(ticketOpen(ticket, w.record)).handle, w.handle);
});
