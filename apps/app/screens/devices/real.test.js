import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { added, agoOf, dayOf, deviceKind, deviceRows, deviceSpaces, pairPhase, payloadOf, phoneAsk, spaceNames, targetsOf, wordsOf } from "./real.js";

const NOW = Date.UTC(2026, 9, 4, 12, 0);

test("relay.devices.list rows become device rows, with the software line only when the box says so", () => {
  const data = { devices: [
    { id: "dev_a", name: "Alex's iPhone", kind: "app", pairedAt: Date.UTC(2026, 7, 12), lastSeen: NOW - 2 * 60_000, presence: true, online: false, path: null, rtt: null },
    { id: "dev_b", name: "Chrome on Mac", kind: "web", pairedAt: Date.UTC(2026, 8, 3), lastSeen: NOW, online: true, path: "relay", trusted: false, storage: "software" },
    { nope: true },
  ] };
  const rows = deviceRows(data, NOW);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].device, rows[0].since, rows[0].last, "software" in rows[0]], ["phone", "12 Aug", "2 min ago", false]);
  assert.deepEqual([rows[1].device, rows[1].last, rows[1].software], ["computer", "Now", true]);
  assert.deepEqual(deviceRows({ devices: [] }), []);
  assert.deepEqual(deviceRows(null), []);
});

test("times read as the screen words them", () => {
  assert.equal(agoOf(NOW - 3 * 3600_000, NOW), "3 h ago");
  assert.equal(agoOf(NOW - 30 * 3600_000, NOW), "Yesterday");
  assert.equal(agoOf(null, NOW), "Not yet");
  assert.equal(dayOf(0), "");
  assert.equal(deviceKind("server"), "server");
});

test("spaces.list names the spaces, and every device is in the person's spaces", () => {
  const names = spaceNames([{ id: "spc_a58c2e0dbfb34fc2", name: "juniperdev.vyre.run", label: "juniperdev", displayName: "Juniper Studio", role: "owner" }, { id: "spc_2", label: "mine" }]);
  assert.deepEqual(names, { spc_a58c2e0dbfb34fc2: "Juniper Studio", spc_2: "mine" });
  assert.deepEqual(deviceSpaces(["d1"], names), { d1: ["spc_a58c2e0dbfb34fc2", "spc_2"] });
  assert.deepEqual(spaceNames(undefined), {});
});

test("wink.pair.targets and the server payload", () => {
  const t = targetsOf({ targets: [{ kind: "identity", id: "per_5r2u464ocdnbl5c7tvgnkasgie", label: "devbox" }, { kind: "space", id: "spc_y2rkpcbrflek", label: "devbox", role: "owner" }, { kind: "x", id: "1" }] });
  assert.deepEqual(t.map((x) => x.kind), ["identity", "space"]);
  const code = { ok: true, kind: "ticket", ticket: "xdnbaOcBNP2lHSKf9DBK9Q", relay: "ws://152.42.187.205:8787", for: "server" };
  assert.equal(payloadOf(code), "vyre://wink/2?t=xdnbaOcBNP2lHSKf9DBK9Q&r=ws%3A%2F%2F152.42.187.205%3A8787");
  assert.equal(payloadOf({ ok: true, kind: "offer", offer: "https://vyre.run/pair#abc" }), "https://vyre.run/pair#abc");
});

test("wink.pair.status maps to what the screen does", () => {
  assert.deepEqual(pairPhase({ state: "waiting" }), { phase: "wait" });
  assert.deepEqual(pairPhase({ state: "confirm", words: ["Amber", "river", "lantern"] }), { phase: "words", words: ["amber", "river", "lantern"] });
  assert.equal(pairPhase({ state: "confirm" }).phase, "wait");
  assert.equal(pairPhase({ state: "done", device: "x" }).phase, "done");
  assert.match(pairPhase({ state: "failed", reason: "That server already belongs to someone." }).say, /already belongs/);
  assert.match(pairPhase({ state: "expired" }).say, /ran out of time/);
  assert.equal(pairPhase(null).phase, "wait");
});

test("wink.phone.pairing and the answer", () => {
  assert.deepEqual(phoneAsk({ asking: false }), { asking: false });
  const a = phoneAsk({ asking: true, name: "Alex's iPhone", words: "cedar harbor violet", until: 1, line: "Say yes only if the words match." });
  assert.deepEqual([a.asking, a.name, a.words], [true, "Alex's iPhone", ["cedar", "harbor", "violet"]]);
  assert.equal(phoneAsk({ asking: true, words: "two words" }).asking, false);
  assert.equal(added({ answered: true, yes: true, name: "x" }), true);
  assert.equal(added({ answered: true, yes: false }), false);
  assert.equal(added({ answered: false }), false);
  assert.equal(wordsOf("a b"), null);
});
