// @ts-check
// The list in the personal vault (space-list-vault.js) over a port that is the vault's own tools. Reading it is one person-present reveal; writing is one update. A vault that is locked or has no item is an empty list.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readList, writeList, syncList } from "./space-list-vault.js";
import { ITEM, FIELD } from "./space-list.js";

const KEY = (/** @type {string} */ n) => `${n}${"k".repeat(43)}`.slice(0, 43);
const srv = (/** @type {string} */ n) => ({ kind: "server", id: KEY(n), name: `server ${n}`, relay: "wss://r", route: "r".repeat(26), box: KEY(n) });

/** A vault with at most one item; every call is recorded. */
function vault(/** @type {string | null} */ text, /** @type {Record<string, any>} */ over = {}) {
  /** @type {Array<[string, any]>} */ const calls = [];
  let item = text;
  return {
    calls,
    get text() { return item; },
    tool: async (/** @type {string} */ name, /** @type {any} */ input) => {
      calls.push([name, input]);
      if (over[name]) throw over[name];
      if (name === "vault.item") { if (item === null) throw Object.assign(new Error("no such item"), { code: "not_found" }); return { name: ITEM, kind: "note", fields: [FIELD] }; }
      if (name === "vault.reveal") return { value: item };
      if (name === "vault.put") { item = input.fields[FIELD]; return { ok: true }; }
      if (name === "vault.update") { item = input.fields[FIELD]; return { ok: true }; }
      throw new Error(`unexpected ${name}`);
    },
  };
}

test("read: no item is an empty list, and nothing is revealed", async () => {
  const v = vault(null);
  assert.deepEqual((await readList(v.tool)).entries, []);
  assert.ok(!v.calls.some((c) => c[0] === "vault.reveal"));
});

test("read: the item's text field is revealed once and parsed", async () => {
  const v = vault(JSON.stringify({ v: 1, seq: 3, entries: [srv("a")], removed: [] }));
  const l = await readList(v.tool);
  assert.deepEqual(l.entries.map((x) => x.id), [KEY("a")]);
  assert.deepEqual(v.calls.filter((c) => c[0] === "vault.reveal").map((c) => c[1]), [{ name: ITEM, field: FIELD }]);
});

test("read: a locked vault or a refused reveal is an empty list with the reason, not a throw", async () => {
  const v = vault("x", { "vault.reveal": Object.assign(new Error("locked"), { code: "locked" }) });
  const r = await readList(v.tool);
  assert.deepEqual(r.entries, []);
  assert.equal(r.unavailable, "locked");
});

test("write: the first write puts a personal note, later writes update it", async () => {
  const v = vault(null);
  await writeList(v.tool, { v: 1, seq: 1, entries: [srv("a")], removed: [] });
  assert.equal(v.calls.at(-1)?.[0], "vault.put");
  assert.equal(v.calls.at(-1)?.[1].kind, "note");
  assert.equal(v.calls.at(-1)?.[1].name, ITEM);
  await writeList(v.tool, { v: 1, seq: 2, entries: [srv("a"), srv("b")], removed: [] });
  assert.equal(v.calls.at(-1)?.[0], "vault.update");
  assert.deepEqual(JSON.parse(/** @type {string} */ (v.text)).entries.map((/** @type {any} */ x) => x.id), [KEY("a"), KEY("b")]);
});

test("sync: this device's servers are merged into what the vault holds and written back; the other device's server comes down to pair", async () => {
  const v = vault(JSON.stringify({ v: 1, seq: 3, entries: [srv("b")], removed: [] }));
  const out = await syncList(v.tool, { pairings: [{ relay: "wss://r", route: "r".repeat(26), box: KEY("a"), name: "server a", device: "d", presence: null }], teams: [] });
  assert.deepEqual(out.list.entries.map((x) => x.id).sort(), [KEY("a"), KEY("b")].sort());
  assert.deepEqual(out.toPair.map((x) => x.id), [KEY("b")], "b is on the list and not on this device");
  const stored = JSON.parse(/** @type {string} */ (v.text));
  assert.deepEqual(stored.entries.map((/** @type {any} */ x) => x.id).sort(), [KEY("a"), KEY("b")].sort(), "and the vault now has a too");
  assert.equal(stored.seq, 4, "written at the next seq");
});

test("sync: a locked vault changes nothing and says so", async () => {
  const v = vault("x", { "vault.reveal": Object.assign(new Error("locked"), { code: "locked" }) });
  const out = await syncList(v.tool, { pairings: [], teams: [] });
  assert.equal(out.unavailable, "locked");
  assert.ok(!v.calls.some((c) => c[0] === "vault.put" || c[0] === "vault.update"), "nothing was written over a list that could not be read");
});

test("sync: a list older than the highest seq this device has seen is ignored, nothing is written, and nothing is paired", async () => {
  const v = vault(JSON.stringify({ v: 1, seq: 2, entries: [srv("b")], removed: [] }));
  const out = await syncList(v.tool, { pairings: [], teams: [] }, 7);
  assert.equal(out.unavailable, "rolled_back");
  assert.deepEqual(out.toPair, []);
  assert.ok(!v.calls.some((c) => c[0] === "vault.put" || c[0] === "vault.update"));
});

test("sync: a tombstoned server is not revived by this device still holding its pairing", async () => {
  const v = vault(JSON.stringify({ v: 1, seq: 5, entries: [], removed: [{ id: KEY("a"), seq: 5 }] }));
  const out = await syncList(v.tool, { pairings: [{ relay: "wss://r", route: "r".repeat(26), box: KEY("a"), name: "server a", device: "d", presence: null }], teams: [] });
  assert.deepEqual(out.list.entries, []);
  assert.ok(!v.calls.some((c) => c[0] === "vault.put" || c[0] === "vault.update"), "and nothing is written");
});

test("sync: a list entry without a pinned box key is never paired by itself; it is handed back to be confirmed by name", async () => {
  const v = vault(JSON.stringify({ v: 1, seq: 1, entries: [{ kind: "server", id: "weak", name: "someone's server", relay: "wss://r", route: "r".repeat(26), box: "weak" }, srv("b")], removed: [] }));
  const out = await syncList(v.tool, { pairings: [], teams: [] });
  assert.deepEqual(out.toPair.map((x) => x.id), [KEY("b")]);
  assert.deepEqual(out.unpinned.map((x) => x.id), ["weak"]);
});
