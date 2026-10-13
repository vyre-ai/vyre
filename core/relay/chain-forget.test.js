// @ts-check
// A chain device taken off the identity list is removed AND its presence key goes with it (core/relay/index.js forget: presence.remove), at its next hello and at its next call. This is a source pin, not a run:
// the end-to-end proof that the key stops verifying is rc2-people's journey on a real daemon.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
const body = (/** @type {string} */ from, /** @type {number} */ len) => src.slice(src.indexOf(from), src.indexOf(from) + len);

test("forget() removes the device's presence key", () => {
  assert.match(body("function forget(id, why) {", 1400), /ctx\.call\("presence\.remove", \{ id: row\.presence_key \}\)/);
});

test("a chain device found gone at its hello, and at its next call, is forgotten (so the key goes with it)", () => {
  assert.match(src, /if \(st\.state === "gone"\) \{ forget\(id, "removed from your identity list"\)/);
  assert.match(src, /if \(st\.state === "gone"\) \{ forget\(String\(input\.id\), "removed from your identity list"\)/);
});

test("the key enrolled for a chain hello is the one the entry key signed", () => {
  assert.match(src, /r\.pk !== "-" && crypto\.createHash\("sha256"\)\.update\(pk\.public_key\)\.digest\("hex"\) === r\.pk/);
});

// rc1-d's terms for chain-grant, pinned at the source (the behaviour on a real chain is rc2-people's walk): the key on the row must be the one enrolled at admission, grants are rate limited, start-paired reads the chain again
// and a chain-born session is short.
const presence = fs.readFileSync(new URL("../presence/module.js", import.meta.url), "utf8");

test("the fact written at admission names the presence key enrolled for it, and chain-grant refuses a different key on the row", () => {
  assert.match(src, /seq: r\.seq, at: now\(\), \.\.\.\(presenceKey \? \{ presenceKey \} : \{\}\)/);
  assert.match(presence, /info\.viaChain\.presenceKey !== info\.presenceKey/);
});

test("chain-grant is rate limited per device and per identity", () => {
  assert.match(presence, /t - \(chainGrants\.get\(device\) \|\| 0\) < 30_000/);
  assert.match(presence, /recent\.length >= 20/);
});

test("start-paired reads the chain again for a chain device and its session is short", () => {
  assert.match(presence, /relay\.device\.info", \{ id: device \}\)\.catch\(\(\) => null\)\) \|\| \{\}\)\.data;\s+if \(chainInfo && chainInfo\.removed\) throw refuse\(\);/);
  assert.match(presence, /UPDATE presence_people SET max = MIN\(max, \?\) WHERE id = \?/);
});
