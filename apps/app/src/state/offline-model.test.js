import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { offlineNotice, OFFLINE_AFTER_MS, clock } from "./offline-model.js";

const fmt = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
const at = Date.UTC(2026, 9, 9, 14, 2, 0);
const room = (o) => offlineNotice({ fmt, paired: true, ...o });

test("a first run with no server never shows the notice, however long it waits or whatever the connection says", () => {
  for (const status of ["live", "reconnecting", "offline"]) {
    assert.equal(room({ paired: false, status, lastSeen: null, now: at + 10 * OFFLINE_AFTER_MS }), null, status);
    assert.equal(room({ paired: false, status, lastSeen: at, now: at + 10 * OFFLINE_AFTER_MS }), null, `${status} with a stale lastSeen`);
  }
});

test("a pairing that has never been answered shows nothing: there is no server yet to be offline from", () => {
  assert.equal(room({ status: "reconnecting", lastSeen: null, now: at + 10 * OFFLINE_AFTER_MS }), null);
});

test("paired and answering says nothing; silent past a minute is offline since the last answer, with what to check; answering again clears it", () => {
  assert.equal(room({ status: "live", lastSeen: at, now: at + 5000 }), null);
  assert.equal(room({ status: "reconnecting", lastSeen: at, now: at + OFFLINE_AFTER_MS - 1 }), null, "a blip that is healing");
  const n = room({ status: "reconnecting", lastSeen: at, now: at + OFFLINE_AFTER_MS });
  assert.equal(n.fact, "Your server has been offline since 14:02");
  assert.match(n.detail, /switched on and online/);
  assert.match(n.detail, /login window/);
  // the server answers again: the stream is open and lastSeen moves forward
  assert.equal(room({ status: "live", lastSeen: at + OFFLINE_AFTER_MS + 2000, now: at + OFFLINE_AFTER_MS + 3000 }), null);
});

test("the device's own offline state is its own pill, not this notice", () => {
  assert.equal(room({ status: "offline", lastSeen: at, now: at + 10 * OFFLINE_AFTER_MS }), null);
  assert.match(clock(at), /\d{1,2}:\d{2}/);
});
