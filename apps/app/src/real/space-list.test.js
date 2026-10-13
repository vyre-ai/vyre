// @ts-check
// The list of a person's servers and teams that travels with their personal vault (space-list.js): where to connect, nothing more. Pure.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOMBSTONE_DAYS, ITEM, FIELD, LIMIT, STEPS, pruneTombstones, entriesFromDevice, isPinned, mergeLists, notOlder, parseList, serializeList, toPair, unpinned, withAdded, withRemoved } from "./space-list.js";

const KEY = "k".repeat(43);
const srv = (/** @type {string} */ box, name = `server ${box}`) => ({ kind: "server", id: box, name, relay: "wss://relay.example.net", route: "r".repeat(26), box });
const pinned = (/** @type {string} */ n) => srv(`${n}${KEY}`.slice(0, 43));
const team = (/** @type {string} */ name) => ({ kind: "team", id: `team:${name}`, name, home: { relay: "wss://relay.example.net", route: "t".repeat(26), box: "bx" } });
const L = (/** @type {number} */ seq, /** @type {any[]} */ entries, /** @type {any[]} */ removed = []) => ({ v: /** @type {const} */ (1), seq, entries, removed });

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
  assert.ok(!/dev_secret|secret|presence/.test(JSON.stringify(e)), "no device id, token or presence rides in the list");
});

test("serialize then parse gives the same list; junk, a wrong version or a bad entry is dropped alone", () => {
  const l = L(5, [srv("a"), team("Northwind")], [{ id: "x", seq: 3 }]);
  assert.deepEqual(parseList(serializeList(l)), l);
  assert.deepEqual(parseList("not json"), L(0, []));
  assert.deepEqual(parseList(JSON.stringify({ v: 9, entries: [srv("a")] })), L(0, []));
  const half = parseList(JSON.stringify({ v: 1, seq: 1, entries: [srv("a"), { kind: "server" }, { kind: "team", id: "team:x" }, null], removed: [{ id: "x", seq: 1 }, "x", { id: 3 }] }));
  assert.deepEqual(half.entries.map((x) => x.id), ["a"]);
  assert.deepEqual(half.removed, [{ id: "x", seq: 1 }]);
});

test("serialize pads to a fixed step, so the stored size does not say how many servers there are", () => {
  const one = serializeList(L(1, [srv("a")]));
  const three = serializeList(L(1, [srv("a"), srv("b"), srv("c")]));
  assert.ok(STEPS.includes(one.length) && STEPS.includes(three.length));
  assert.equal(one.length, three.length, "one server and three look the same in size");
  assert.deepEqual(parseList(one).entries.map((x) => x.id), ["a"], "the padding is ignored when read");
});

test("serialize refuses a list that would not fit the item, in words", () => {
  const big = L(1, Array.from({ length: 200 }, (_, n) => srv(`box${n}`, "n".repeat(60))));
  assert.throws(() => serializeList(big), (/** @type {any} */ e) => e.code === "list_too_big" && /Remove a server/.test(e.message));
  assert.equal(LIMIT, 8192);
});

test("merge: entries from both sides are kept, the same id once, and the higher seq names it", () => {
  const m = mergeLists(L(1, [srv("a"), srv("b")]), L(2, [srv("b", "renamed"), srv("c")]));
  assert.deepEqual(m.entries.map((x) => [x.id, x.name]), [["a", "server a"], ["b", "renamed"], ["c", "server c"]]);
  assert.equal(m.seq, 2);
});

test("tombstones: a removed server stays out of a stale writer's list; adding it again on purpose brings it back", () => {
  const removed = withRemoved(L(4, [srv("a"), srv("b")]), "a");
  assert.equal(removed.seq, 5);
  assert.equal(removed.removed[0].id, "a");
  assert.equal(removed.removed[0].seq, 5);
  const stale = mergeLists(removed, L(4, [srv("a")]));
  assert.deepEqual(stale.entries.map((x) => x.id), ["b"], "a device still holding it at an older seq does not revive it");
  const sameSeq = mergeLists(removed, L(5, [srv("a")]));
  assert.deepEqual(sameSeq.entries.map((x) => x.id), ["b"], "nor one at the tombstone's own seq");
  const back = withAdded(removed, srv("a"));
  assert.equal(back.seq, 6);
  assert.deepEqual(back.removed, []);
  assert.deepEqual(mergeLists(back, removed).entries.map((x) => x.id).sort(), ["a", "b"], "the person adding it again wins over the old tombstone");
  assert.equal(withRemoved(removed, "a").removed.length, 1, "no duplicate tombstone");
});

test("rollback: a list older than the highest this device has seen is not accepted", () => {
  assert.equal(notOlder(L(3, []), 5).ok, false);
  assert.equal(notOlder(L(5, []), 5).ok, true);
  assert.equal(notOlder(L(6, []), 5).ok, true);
});

test("pins: an entry with no box key is never connected to by itself; it is listed to be confirmed by name", () => {
  assert.equal(isPinned(pinned("a")), true);
  assert.equal(isPinned(srv("short")), false);
  assert.equal(isPinned(team("Northwind")), false, "a team is joined by invite, not pinned");
  const list = L(1, [pinned("a"), pinned("b"), srv("nopin"), team("Northwind")]);
  assert.deepEqual(toPair(list, [pinned("a").box]).map((x) => x.id), [pinned("b").id], "the one it has, the unpinned one and the team are not to be paired");
  assert.deepEqual(unpinned(list, []).map((x) => x.id), ["nopin"]);
  assert.deepEqual(toPair(list, []).map((x) => x.id), [pinned("a").id, pinned("b").id]);
});

test("tombstones older than 90 days are dropped so the list does not grow without bound; a young one stays", () => {
  const day = 86_400_000, now = 1_000 * day;
  const l = { v: /** @type {const} */ (1), seq: 9, entries: [], removed: [{ id: "old", seq: 3, at: now - 91 * day }, { id: "young", seq: 4, at: now - 10 * day }, { id: "noat", seq: 2 }] };
  assert.equal(TOMBSTONE_DAYS, 90);
  assert.deepEqual(pruneTombstones(l, now).removed.map((t) => t.id).sort(), ["noat", "young"], "one with no time is kept, never guessed old");
  assert.deepEqual(withRemoved(L(1, [srv("a")]), "a", 5_000).removed, [{ id: "a", seq: 2, at: 5_000 }], "a removal records when");
});
