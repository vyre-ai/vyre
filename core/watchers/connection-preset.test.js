// @ts-check
// A Connection's poll as a watcher (the generic connector watcher, no per-service code): the preset builds from the Connection's own declaration, with the Connection's credential (conn-<id>) as the
// watcher's one way out, only the host the Connection pins, and the variables the poll needs. The watcher itself runs in a real child on a runner (connector-watch.test.js); this checks what is built.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreset } from "./presets.js";
import { fromForm } from "../../records/connectors/connection.js";

const form = () => fromForm({
  label: "GoHighLevel Sales", base_url: "https://services.leadconnectorhq.com", send: { how: "bearer" }, credential: { item: "ghl-pat" }, headers: { Version: "2021-07-28" }, check: { path: "/locations/abc" },
  operations: [{ name: "contacts.recent", method: "GET", path: "/contacts", label: "New contacts",
    poll: { items: "contacts", id: "id", title: "contactName", at: "dateAdded", args: { query: { locationId: "$location", limit: "100" } }, every_minutes: 15 } }],
});

test("a Connection's poll builds a read-only watcher on its own host with its own credential", () => {
  const m = form();
  const p = buildPreset({ kind: "connector", project: "harlow-legal", connector: m.id, poll: "contacts.recent", credential: "conn-gohighlevel-sales", vars: { location: "abc" } }, { declaration: m.declaration });
  assert.equal(p.json.params.connector, "gohighlevel-sales");
  assert.equal(p.json.params.poll, "contacts.recent");
  assert.equal(p.json.params.location, "abc");
  assert.deepEqual(Object.keys(p.json.net), ["services.leadconnectorhq.com"]);
  assert.deepEqual(p.json.net["services.leadconnectorhq.com"], { credential: "conn-gohighlevel-sales" });
  assert.equal(p.json.emits, "gohighlevel-sales.found");
  assert.match(p.code, /method: "GET"/);
  assert.ok(!/POST|DELETE|PUT|PATCH/.test(p.code.split("const LOOP")[0] || ""), "the generated plan only ever reads");
  assert.match(p.code, /"path":"\/contacts"/);
  assert.match(p.code, /"title":"contactName"/);
});

test("the poll must be one the Connection declares, with every variable it needs; a model cannot hand the preset its own declaration", () => {
  const m = form();
  assert.throws(() => buildPreset({ kind: "connector", project: "p", connector: m.id, poll: "contacts.recent", credential: "conn-x" }, { declaration: m.declaration }), /needs location/);
  assert.throws(() => buildPreset({ kind: "connector", project: "p", connector: m.id, poll: "nope", credential: "conn-x", vars: { location: "a" } }, { declaration: m.declaration }), /has no poll nope/);
  // a declaration in the preset's own input is not heard: only the one the caller resolved from the connectors module counts
  assert.throws(() => buildPreset({ kind: "connector", project: "p", connector: "gohighlevel-sales", poll: "contacts.recent", credential: "conn-x", vars: { location: "a" }, declaration: m.declaration }), /names a Connection|names a connector this build declares/);
});

test("a GoHighLevel-shaped poll fires: the generated watcher lists the contacts on the pinned host and files each with its own id and title", async t => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const m = form();
  const p = buildPreset({ kind: "connector", project: "harlow-legal", connector: m.id, poll: "contacts.recent", credential: "conn-gohighlevel-sales", vars: { location: "abc" } }, { declaration: m.declaration });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-conn-poll-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify(p.json));
  fs.writeFileSync(path.join(dir, "watch.mjs"), p.code);
  const seen = /** @type {string[]} */ ([]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {string} */ u) => {
    seen.push(String(u));
    return new Response(JSON.stringify({ contacts: [{ id: "c1", contactName: "Dana Reyes", dateAdded: "2026-10-08T10:00:00Z" }, { id: "c2", contactName: "Sam Ortiz", dateAdded: "2026-10-08T11:00:00Z" }, { contactName: "no id" }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  t.after(() => { globalThis.fetch = realFetch; });
  const { default: watch } = await import(path.join(dir, "watch.mjs"));
  /** @type {any[]} */ const filed = [], said = /** @type {string[]} */ ([]);
  // the first look starts quietly from now; the next one files what the list shows
  const first = await watch({ since: null, emit: (/** @type {any} */ x) => filed.push(x), log: (/** @type {string} */ x) => said.push(x) });
  assert.equal(filed.length, 0); assert.ok(first.at);
  await watch({ since: { at: Date.now() - 3600_000 }, emit: (/** @type {any} */ x) => filed.push(x), log: (/** @type {string} */ x) => said.push(x) });
  assert.deepEqual(filed.map(x => [x.id, x.title]), [["c1", "Dana Reyes"], ["c2", "Sam Ortiz"]]);
  assert.ok(said.some(l => /no id and was skipped/.test(l)));
  assert.equal(seen.length, 1);
  const u = new URL(seen[0]);
  assert.equal(u.origin, "https://services.leadconnectorhq.com"); assert.equal(u.pathname, "/contacts");
  assert.equal(u.searchParams.get("locationId"), "abc"); assert.equal(u.searchParams.get("limit"), "100");
});
