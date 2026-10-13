// @ts-check
// The list in the personal vault (space-list-vault.js) over a port that is the vault's own tools. Reading it is one person-present reveal; writing is one update. A vault that is locked or has no item is an empty list.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readList, writeList, syncList } from "./space-list-vault.js";
import { ITEM, FIELD } from "./space-list.js";

const srv = (/** @type {string} */ box) => ({ kind: "server", id: box, name: `server ${box}`, relay: "wss://r", route: "r".repeat(26), box });

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
  const v = vault(JSON.stringify({ v: 1, at: 3, entries: [srv("a")], removed: [] }));
  const l = await readList(v.tool);
  assert.deepEqual(l.entries.map((x) => x.id), ["a"]);
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
  await writeList(v.tool, { v: 1, at: 1, entries: [srv("a")], removed: [] });
  assert.equal(v.calls.at(-1)?.[0], "vault.put");
  assert.equal(v.calls.at(-1)?.[1].kind, "note");
  assert.equal(v.calls.at(-1)?.[1].name, ITEM);
  await writeList(v.tool, { v: 1, at: 2, entries: [srv("a"), srv("b")], removed: [] });
  assert.equal(v.calls.at(-1)?.[0], "vault.update");
  assert.deepEqual(JSON.parse(/** @type {string} */ (v.text)).entries.map((/** @type {any} */ x) => x.id), ["a", "b"]);
});

test("sync: this device's servers are merged into what the vault holds and written back; the other device's server comes down to pair", async () => {
  const v = vault(JSON.stringify({ v: 1, at: 3, entries: [srv("b")], removed: [] }));
  const out = await syncList(v.tool, { pairings: [{ relay: "wss://r", route: "r".repeat(26), box: "a", name: "server a", device: "d", presence: null }], teams: [] });
  assert.deepEqual(out.list.entries.map((x) => x.id).sort(), ["a", "b"]);
  assert.deepEqual(out.toPair.map((x) => x.id), ["b"], "b is on the list and not on this device");
  assert.deepEqual(JSON.parse(/** @type {string} */ (v.text)).entries.map((/** @type {any} */ x) => x.id).sort(), ["a", "b"], "and the vault now has a too");
});

test("sync: a locked vault changes nothing and says so", async () => {
  const v = vault("x", { "vault.reveal": Object.assign(new Error("locked"), { code: "locked" }) });
  const out = await syncList(v.tool, { pairings: [], teams: [] });
  assert.equal(out.unavailable, "locked");
  assert.ok(!v.calls.some((c) => c[0] === "vault.put" || c[0] === "vault.update"), "nothing was written over a list that could not be read");
});
