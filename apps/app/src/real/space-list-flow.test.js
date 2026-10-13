// @ts-check
// The list in the app (space-list-flow.js): read once when the vault opens and when Settings, Servers opens; written with the yes already given for a pair, a join or a leave; connecting what the person's
// other devices found, by the pinned box key and never by a typed code. The vault is a fake with the real tools' names; the chain pairing (server lane) is a fake port.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeListFlow } from "./space-list-flow.js";
import { ITEM, FIELD, parseList } from "./space-list.js";

const KEY = (/** @type {string} */ n) => `${n}${"k".repeat(43)}`.slice(0, 43);
const srv = (/** @type {string} */ n, /** @type {string} */ box = KEY(n)) => ({ kind: "server", id: box, name: `server ${n}`, relay: "wss://r", route: "r".repeat(26), box });
const pairing = (/** @type {string} */ n) => ({ relay: "wss://r", route: "r".repeat(26), box: KEY(n), name: `server ${n}` });
const list = (/** @type {number} */ seq, /** @type {any[]} */ entries, /** @type {any[]} */ removed = []) => JSON.stringify({ v: 1, seq, entries, removed });

/** A vault holding at most the list item; every call recorded; `locked` makes every call refuse. */
function vault(/** @type {string | null} */ text) {
  /** @type {Array<[string, any]>} */ const calls = [];
  const v = {
    calls, locked: false, item: text,
    tool: async (/** @type {string} */ name, /** @type {any} */ input) => {
      calls.push([name, input]);
      if (v.locked) throw Object.assign(new Error("locked"), { code: "locked" });
      if (name === "vault.item") { if (v.item === null) throw Object.assign(new Error("none"), { code: "not_found" }); return { name: ITEM }; }
      if (name === "vault.reveal") return { value: v.item };
      if (name === "vault.put" || name === "vault.update") { v.item = input.fields[FIELD]; return { ok: true }; }
      throw new Error(`unexpected ${name}`);
    },
    get stored() { return parseList(v.item); },
    writes: () => calls.filter((c) => c[0] === "vault.put" || c[0] === "vault.update").length,
  };
  return v;
}

/** A device: its pairings and teams, the counters it keeps, and a fake chain pairing. */
function device(/** @type {ReturnType<typeof vault>} */ v, /** @type {string[]} */ have = [], over = {}) {
  const d = {
    pairings: have.map(pairing), teams: /** @type {any[]} */ ([]),
    seen: 0, pending: /** @type {string[]} */ ([]), chain: /** @type {any[]} */ ([]), saved: /** @type {any[]} */ ([]),
    ...over,
  };
  const flow = makeListFlow({
    tool: v.tool,
    device: async () => ({ pairings: d.pairings, teams: d.teams }),
    state: { seen: async () => d.seen, setSeen: async (n) => { d.seen = n; }, pending: async () => d.pending, setPending: async (p) => { d.pending = p; } },
    pairByChain: async (e) => { d.chain.push(e.box); if (e.box === KEY("bad")) throw Object.assign(new Error("refused"), { code: "refused" }); return { ...pairing(e.box.slice(0, 1)), box: e.box }; },
    onPaired: async (p) => { d.saved.push(p.box); d.pairings.push(p); },
    now: () => 1_000,
  });
  return { d, flow };
}

test("a fresh device that opens the vault finds both servers, pinned, and writes nothing", async () => {
  const v = vault(list(4, [srv("a"), srv("b")]));
  const { d, flow } = device(v);
  const r = await flow.sync();
  assert.deepEqual(r.found.map((e) => e.box), [KEY("a"), KEY("b")]);
  assert.deepEqual(r.confirm, []);
  assert.equal(v.writes(), 0);
  assert.equal(d.seen, 4);
});

test("reading is one item check and one reveal: no extra prompt, no background read", async () => {
  const v = vault(list(1, [srv("a")]));
  const { flow } = device(v, ["a"]);
  await flow.sync();
  assert.deepEqual(v.calls.map((c) => c[0]), ["vault.item", "vault.reveal"]);
});

test("a locked vault changes nothing and says why", async () => {
  const v = vault(list(1, [srv("a")]));
  v.locked = true;
  const { flow } = device(v);
  const r = await flow.sync();
  assert.equal(r.unavailable, "locked");
  assert.deepEqual(r.found, []);
  assert.equal(v.writes(), 0);
});

test("a list older than the highest seen is a rollback: ignored, nothing written", async () => {
  const v = vault(list(3, [srv("a")]));
  const { flow } = device(v, ["b"], { seen: 5 });
  const r = await flow.sync();
  assert.equal(r.unavailable, "rolled_back");
  assert.equal(v.writes(), 0);
});

test("a server this device paired joins the list with one update, at the next seq", async () => {
  const v = vault(list(2, [srv("a")]));
  const { flow } = device(v, ["a", "b"]);
  await flow.added(pairing("b"));
  assert.equal(v.writes(), 1);
  assert.equal(v.calls.at(-1)?.[0], "vault.update");
  assert.deepEqual(v.stored.entries.map((e) => e.id).sort(), [KEY("a"), KEY("b")]);
  assert.equal(v.stored.seq, 3);
});

test("the first server ever paired makes the list item", async () => {
  const v = vault(null);
  const { flow } = device(v, ["a"]);
  await flow.added(pairing("a"));
  assert.equal(v.calls.at(-1)?.[0], "vault.put");
  assert.deepEqual(v.stored.entries.map((e) => e.id), [KEY("a")]);
});

test("leaving writes a tombstone and the server stays out on another device", async () => {
  const v = vault(list(2, [srv("a"), srv("b")]));
  const one = device(v, ["a", "b"]);
  one.d.pairings = one.d.pairings.filter((p) => p.box !== KEY("b"));
  await one.flow.left(KEY("b"));
  assert.deepEqual(v.stored.entries.map((e) => e.id), [KEY("a")]);
  assert.deepEqual(v.stored.removed.map((t) => t.id), [KEY("b")]);
  // a second device that still holds b does not bring it back
  const two = device(v, ["a", "b"]);
  const r = await two.flow.sync();
  assert.deepEqual(v.stored.entries.map((e) => e.id), [KEY("a")]);
  assert.deepEqual(r.found, []);
});

test("a leave while the vault is locked is kept and written at the next open", async () => {
  const v = vault(list(2, [srv("a"), srv("b")]));
  const { d, flow } = device(v, ["a"]);
  v.locked = true;
  await flow.left(KEY("b"));
  assert.deepEqual(d.pending, [KEY("b")]);
  assert.equal(v.writes(), 0);
  v.locked = false;
  await flow.sync();
  assert.deepEqual(v.stored.entries.map((e) => e.id), [KEY("a")]);
  assert.deepEqual(d.pending, []);
});

test("adding a removed server again on purpose brings it back", async () => {
  const v = vault(list(3, [srv("a")], [{ id: KEY("b"), seq: 3 }]));
  const { flow } = device(v, ["a", "b"]);
  await flow.added(pairing("b"));
  assert.deepEqual(v.stored.entries.map((e) => e.id).sort(), [KEY("a"), KEY("b")]);
  assert.deepEqual(v.stored.removed, []);
});

test("an entry with no pin is shown by name for confirmation and is never connected", async () => {
  const v = vault(list(1, [srv("a"), srv("u", "short")]));
  const { d, flow } = device(v);
  const r = await flow.sync();
  assert.deepEqual(r.found.map((e) => e.box), [KEY("a")]);
  assert.deepEqual(r.confirm.map((e) => e.name), ["server u"]);
  await assert.rejects(() => flow.connect(r.confirm[0]), (e) => /** @type {any} */ (e).code === "unpinned");
  assert.deepEqual(d.chain, []);
});

test("connect uses the pinned box key, saves the pairing, and needs no typed code", async () => {
  const v = vault(list(1, [srv("a")]));
  const { d, flow } = device(v);
  const r = await flow.sync();
  await flow.connect(r.found[0]);
  assert.deepEqual(d.chain, [KEY("a")]);
  assert.deepEqual(d.saved, [KEY("a")]);
});

test("connect all: one server refusing does not stop the next, and the answer names it", async () => {
  const v = vault(list(1, [srv("bad"), srv("c")]));
  const { d, flow } = device(v);
  const r = await flow.sync();
  const out = await flow.connectAll(r.found);
  assert.deepEqual(out.done.map((e) => e.box), [KEY("c")]);
  assert.deepEqual(out.failed.map((f) => [f.entry.name, f.code]), [["server bad", "refused"]]);
  assert.deepEqual(d.saved, [KEY("c")]);
});

test("opening the vault: reads, then connects every pinned server not yet paired", async () => {
  const v = vault(list(2, [srv("a"), srv("b"), srv("u", "short")]));
  const { d, flow } = device(v, ["a"]);
  const r = await flow.opened();
  assert.deepEqual(d.saved, [KEY("b")]);
  assert.deepEqual(r.confirm.map((e) => e.name), ["server u"]);
  assert.equal(v.writes(), 0);
});

test("a vault that cannot be read is never written over", async () => {
  const v = vault(list(2, [srv("a")]));
  v.locked = true;
  const { flow } = device(v, ["a", "b"]);
  await flow.added(pairing("b"));
  assert.equal(v.writes(), 0);
});

test("mock walk: a fresh device opens the vault and lists both servers under Found on your other devices, then connects them with no code", async () => {
  const { FOUND, foundRows } = await import("../../screens/settings/servers-model.js");
  const v = vault(list(5, [srv("a"), srv("b")]));
  const { d, flow } = device(v);
  const r = await flow.sync();
  const rows = foundRows({ found: r.found, confirm: r.confirm, failed: [] });
  const shown = [FOUND.title, ...rows.map((x) => `${x.name} [${x.action}]`)];
  assert.deepEqual(shown, ["Found on your other devices", "server a [Connect]", "server b [Connect]"]);
  const out = await flow.connectAll(r.found);
  assert.equal(out.done.length, 2);
  assert.deepEqual(d.saved, [KEY("a"), KEY("b")]);
  assert.equal(v.writes(), 0);
  assert.deepEqual(foundRows({ found: [], confirm: [], failed: out.failed }), []);
});

test("the vault door is the list note only: any other vault name is refused before a call is made", async () => {
  const { onlyTheList } = await import("./space-list-flow.js");
  /** @type {string[]} */ const seen = [];
  const t = onlyTheList(async (n, i) => { seen.push(`${n}:${i?.name}`); return {}; });
  await t("vault.reveal", { name: ITEM, field: FIELD });
  await assert.rejects(() => t("vault.reveal", { name: "bank", field: "pw" }), (e) => /** @type {any} */ (e).code === "not_the_list");
  await assert.rejects(() => t("vault.list", {}), (e) => /** @type {any} */ (e).code === "not_the_list");
  await assert.rejects(() => t("records.list", { name: ITEM }), (e) => /** @type {any} */ (e).code === "not_the_list");
  assert.deepEqual(seen, [`vault.reveal:${ITEM}`]);
});

test("a member's list lives in their personal store: the same four vault calls become vault.me.store.get and put on the key vyre-space-list", async () => {
  const { memberTool } = await import("./space-list-flow.js");
  /** @type {Array<[string, any]>} */ const calls = [];
  let stored = /** @type {any} */ (null);
  const t = memberTool(async (n, i) => { calls.push([n, i]); if (n === "vault.me.store.get") return stored; if (n === "vault.me.store.put") { stored = i.value; return { key: i.key, stored: true }; } throw new Error(n); });
  await assert.rejects(() => t("vault.item", { name: ITEM }), (e) => /** @type {any} */ (e).code === "not_found");
  await t("vault.put", { name: ITEM, kind: "note", fields: { [FIELD]: "T1" } });
  assert.equal(calls.at(-1)?.[1].key, "vyre-space-list");
  assert.equal((await t("vault.item", { name: ITEM })).name, ITEM);
  assert.deepEqual(await t("vault.reveal", { name: ITEM, field: FIELD }), { value: "T1" });
  await t("vault.update", { name: ITEM, fields: { [FIELD]: "T2" } });
  assert.equal(stored, "T2");
});

test("a member's whole flow runs over the member store: a fresh device lists the servers, and a locked store changes nothing", async () => {
  const { memberTool } = await import("./space-list-flow.js");
  let stored = /** @type {any} */ (list(2, [srv("a")]));
  let locked = false;
  const raw = async (/** @type {string} */ n, /** @type {any} */ i) => { if (locked) throw Object.assign(new Error("locked"), { code: "locked" }); if (n === "vault.me.store.get") return stored; stored = i.value; return {}; };

  const f2 = makeListFlow({ tool: memberTool(raw), device: async () => ({ pairings: [], teams: [] }), state: { seen: async () => 0, setSeen: async () => {}, pending: async () => [], setPending: async () => {} }, pairByChain: async () => { throw new Error("x"); }, onPaired: async () => {} });
  assert.deepEqual((await f2.sync()).found.map((e) => e.box), [KEY("a")]);
  locked = true;
  assert.equal((await f2.sync()).unavailable, "locked");
});
