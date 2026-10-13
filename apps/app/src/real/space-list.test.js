// @ts-check
// The list of a person's servers and teams that travels with their personal vault (space-list.js): where to connect, nothing more. Pure.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { ITEM, FIELD, LIMIT, entriesFromDevice, parseList, mergeLists, serializeList, toPair, withRemoved } from "./space-list.js";

const srv = (/** @type {string} */ box, name = `server ${box}`) => ({ kind: "server", id: box, name, relay: "wss://relay.example.net", route: "r".repeat(26), box });
const team = (/** @type {string} */ name) => ({ kind: "team", id: `team:${name}`, name, home: { relay: "wss://relay.example.net", route: "t".repeat(26), box: "bx" } });

test("the vault item is a personal note with one text field", () => {
  assert.equal(ITEM, "vyre-space-list");
  assert.equal(FIELD, "text");
});

test("entriesFromDevice: this device's pairings and joined teams become entries, with only where to connect", () => {
  const e = entriesFromDevice({
    pairings: [{ relay: "wss://r", route: "rt1", box: "boxa", name: "my droplet", device: "dev_secret", presence: { enrolled: true } }],
    teams: [{ name: "Northwind", home: { relay: "wss://r", route: "rt2", box: "bx" }, token: "secret" }],
  });
  assert.deepEqual(e.map((x) => [x.kind, x.id, x.name]), [["server", "boxa", "my droplet"], ["team", "team:Northwind", "Northwind"]]);
  const text = JSON.stringify(e);
  assert.ok(!/dev_secret|secret|presence/.test(text), "no device id, token or presence rides in the list");
});

test("serialize then parse gives the same list; junk, a wrong version or a bad entry is dropped alone", () => {
  const l = { v: 1, at: 5, entries: [srv("a"), team("Northwind")], removed: [] };
  assert.deepEqual(parseList(serializeList(l)), l);
  assert.deepEqual(parseList("not json"), { v: 1, at: 0, entries: [], removed: [] });
  assert.deepEqual(parseList(JSON.stringify({ v: 9, entries: [srv("a")] })), { v: 1, at: 0, entries: [], removed: [] });
  const half = parseList(JSON.stringify({ v: 1, at: 1, entries: [srv("a"), { kind: "server" }, { kind: "team", id: "team:x" }, null], removed: ["x", 3] }));
  assert.deepEqual(half.entries.map((x) => x.id), ["a"]);
  assert.deepEqual(half.removed, ["x"]);
});

test("merge: entries from both sides are kept, the same id once, and a removal beats an older entry", () => {
  const a = { v: 1, at: 1, entries: [srv("a"), srv("b")], removed: [] };
  const b = { v: 1, at: 2, entries: [srv("b", "renamed"), srv("c")], removed: [] };
  assert.deepEqual(mergeLists(a, b).entries.map((x) => [x.id, x.name]), [["a", "server a"], ["b", "renamed"], ["c", "server c"]], "the newer side names it");
  const gone = withRemoved(a, "a");
  assert.deepEqual(gone.entries.map((x) => x.id), ["b"]);
  assert.deepEqual(mergeLists(gone, { v: 1, at: 0, entries: [srv("a")], removed: [] }).entries.map((x) => x.id), ["b"], "an older device does not bring it back");
});

test("withRemoved: a server the person removed stays out of the list on every device that merges", () => {
  const l = withRemoved({ v: 1, at: 1, entries: [srv("a")], removed: [] }, "a");
  assert.deepEqual(l.removed, ["a"]);
  assert.equal(withRemoved(l, "a").removed.length, 1, "no duplicate");
  const again = mergeLists(l, { v: 1, at: 9, entries: [srv("a")], removed: [] });
  assert.deepEqual(again.entries, [], "a stale copy cannot revive it");
});

test("toPair: what a new device still has to pair to, servers only, never what it already has", () => {
  const list = { v: 1, at: 1, entries: [srv("a"), srv("b"), team("Northwind")], removed: [] };
  assert.deepEqual(toPair(list, ["a"]).map((x) => x.id), ["b"]);
  assert.deepEqual(toPair(list, ["a", "b"]), []);
  assert.deepEqual(toPair(list, []).map((x) => x.id), ["a", "b"]);
});

test("serialize refuses a list that would not fit the item, in words", () => {
  const big = { v: 1, at: 1, entries: Array.from({ length: 200 }, (_, n) => srv(`box${n}`, "n".repeat(60))), removed: [] };
  assert.throws(() => serializeList(big), (/** @type {any} */ e) => e.code === "list_too_big" && /Remove a server/.test(e.message));
  assert.ok(LIMIT >= 4000);
});
