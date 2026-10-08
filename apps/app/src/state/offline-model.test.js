import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineNotice, OFFLINE_AFTER_MS, clock } from "./offline-model.js";

const fmt = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
const at = Date.UTC(2026, 9, 9, 14, 2, 0);

test("a server silent for a minute or more is offline since the last time it answered, and the owner is told what to check", () => {
  const n = offlineNotice({ status: "reconnecting", lastSeen: at, now: at + OFFLINE_AFTER_MS, fmt });
  assert.equal(n.fact, "Your server has been offline since 14:02");
  assert.match(n.detail, /switched on and online/);
  assert.match(n.detail, /login window/);
});

test("a blip that is healing, a live connection and the device's own offline state say nothing here", () => {
  assert.equal(offlineNotice({ status: "reconnecting", lastSeen: at, now: at + OFFLINE_AFTER_MS - 1, fmt }), null);
  assert.equal(offlineNotice({ status: "live", lastSeen: at, now: at + 10 * OFFLINE_AFTER_MS, fmt }), null);
  assert.equal(offlineNotice({ status: "offline", lastSeen: at, now: at + 10 * OFFLINE_AFTER_MS, fmt }), null);
});

test("when the app never heard from the server it says it is not answering, with no invented time", () => {
  assert.equal(offlineNotice({ status: "reconnecting", lastSeen: null, now: at, fmt }).fact, "Your server is not answering");
  assert.match(clock(at), /\d{2}:\d{2}/);
});
