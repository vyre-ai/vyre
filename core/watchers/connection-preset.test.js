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
