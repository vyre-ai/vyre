// The Windows app's pairing page waits up to 90 seconds for the box's handshake, because the box now
// waits for the person's Confirm tap before it enrols a pairing. The client's own default (15 seconds)
// stays for ordinary dials, and pairOffer takes the override as `timeout`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync(new URL("../local/capsule/native-win/app/ui/pair.js", import.meta.url), "utf8");
const client = fs.readFileSync(new URL("../relay/client/client.js", import.meta.url), "utf8");

test("windows pair.js: the pairing handshake waits 90 seconds, passed to pairOffer", () => {
  assert.match(page, /const PAIR_HANDSHAKE_MS = 90_000;/);
  assert.match(page, /pairOffer\(found\.offer,[^;]*timeout: PAIR_HANDSHAKE_MS/);
});

test("relay client: the default handshake stays 15 seconds and pairOffer's timeout overrides it", () => {
  assert.match(client, /const HANDSHAKE_MS = 15_000;/);
  assert.match(client, /o\.timeout \?\? HANDSHAKE_MS/);
  assert.match(client, /timeout: o\.timeout \}\)\)/);
});
