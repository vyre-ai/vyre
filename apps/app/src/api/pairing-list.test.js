// @ts-check
// The pairings a device keeps (pairing-list.ts): one per server it is paired to, keyed by the server's box id, with one active as the fallback.
// An older single saved pairing is read as a list of one, so a device paired before this change keeps its server.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./pairing-list.ts");
const P = (/** @type {string} */ box, extra = {}) => ({ relay: "wss://relay.example.net", route: "r".repeat(26), box, name: `server ${box}`, device: `dev_${box}`, presence: null, ...extra });

test("pairing list: an older single record reads as a list of one with that server active", { skip: !strip }, async () => {
  const { readPairings } = await load();
  const got = readPairings(JSON.stringify(P("boxa")));
  assert.deepEqual(Object.keys(got.items), ["boxa"]);
  assert.equal(got.active, "boxa");
  assert.equal(got.v, 2);
});

test("pairing list: nothing, junk or a record with no relay reads as an empty list", { skip: !strip }, async () => {
  const { readPairings } = await load();
  for (const bad of [null, undefined, "", "{", "[]", JSON.stringify({ relay: "http://x", route: "a", box: "b" }), JSON.stringify({ v: 2, items: { a: { relay: "no" } }, active: "a" })]) {
    assert.deepEqual(readPairings(/** @type {any} */ (bad)), { v: 2, items: {}, active: null }, String(bad));
  }
});

test("pairing list: a second server is added beside the first; the first stays active until the person picks another", { skip: !strip }, async () => {
  const { readPairings, addPairing, setActive, activePairing, listPairings } = await load();
  let l = readPairings(null);
  l = addPairing(l, P("boxa"));
  assert.equal(activePairing(l)?.box, "boxa", "the first becomes active");
  l = addPairing(l, P("boxb"));
  assert.equal(activePairing(l)?.box, "boxa", "a second does not take it");
  assert.deepEqual(listPairings(l).map((p) => p.box), ["boxa", "boxb"]);
  l = setActive(l, "boxb");
  assert.equal(activePairing(l)?.box, "boxb");
  assert.equal(setActive(l, "nope"), l, "an unknown id changes nothing");
});

test("pairing list: adding the same server again replaces its record, it never duplicates", { skip: !strip }, async () => {
  const { readPairings, addPairing, listPairings } = await load();
  let l = addPairing(addPairing(readPairings(null), P("boxa", { name: "old" })), P("boxa", { name: "new", device: "dev_new" }));
  assert.equal(listPairings(l).length, 1);
  assert.equal(listPairings(l)[0].name, "new");
});

test("pairing list: removing the active one hands active to the next; removing the last leaves none; removing one that is not there changes nothing", { skip: !strip }, async () => {
  const { readPairings, addPairing, removePairing, activePairing, listPairings } = await load();
  let l = addPairing(addPairing(readPairings(null), P("boxa")), P("boxb"));
  assert.equal(removePairing(l, "zzz"), l);
  l = removePairing(l, "boxa");
  assert.deepEqual(listPairings(l).map((p) => p.box), ["boxb"]);
  assert.equal(activePairing(l)?.box, "boxb");
  l = removePairing(l, "boxb");
  assert.equal(activePairing(l), null);
  assert.equal(l.active, null);
});

test("pairing list: written and read back it is the same list, and what is written holds only the pairing fields", { skip: !strip }, async () => {
  const { readPairings, addPairing, writePairings, listPairings } = await load();
  const l = addPairing(addPairing(readPairings(null), P("boxa")), P("boxb", { extra: "no", token: "secret" }));
  const text = writePairings(l);
  assert.deepEqual(readPairings(text), JSON.parse(JSON.stringify(readPairings(text))));
  assert.deepEqual(listPairings(readPairings(text)).map((p) => p.box), ["boxa", "boxb"]);
  assert.ok(!/secret|"extra"/.test(text), "unknown fields are not kept");
});

test("pairing list: one broken record does not lose the others", { skip: !strip }, async () => {
  const { readPairings, listPairings } = await load();
  const l = readPairings(JSON.stringify({ v: 2, items: { boxa: P("boxa"), boxb: { relay: "x" }, boxc: P("boxc") }, active: "boxb" }));
  assert.deepEqual(listPairings(l).map((p) => p.box), ["boxa", "boxc"]);
  assert.equal(l.active, "boxa", "active falls to one that is there");
});
