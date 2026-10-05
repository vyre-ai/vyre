// A real Twenty: the types of the base Kit are defined with their stored views, and the Records hold those views (kind, fields, groups, sort, filter);
// a changed view is replaced, a removed one is gone, and a type with no views makes none. Skipped unless VYRE_TWENTY_LIVE_URL is set (see conformance-live.sh).
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTwentyStore } from "../store.js";
import { TwentyClient } from "../client.js";
import { viewId, readView } from "../views.js";
import { CORE_TYPES } from "../../../records/core-types.js";
import { kitFromLibrary } from "../../../records/kits/library.js";

const SPACE = `viewlive${Date.now().toString(36)}`;
const URL_ = process.env.VYRE_TWENTY_LIVE_URL, KEY_FILE = process.env.VYRE_TWENTY_LIVE_KEY_FILE;
if (!URL_ || !KEY_FILE) test("live views (skipped: set VYRE_TWENTY_LIVE_URL and VYRE_TWENTY_LIVE_KEY_FILE)", { skip: true }, () => {});
else test("the base Kit's views are the Records' views", { timeout: 300000 }, async () => {
  const client = new TwentyClient({ url: URL_, key: () => fs.readFileSync(KEY_FILE, "utf8").trim() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-views-"));
  const store = createTwentyStore({ client, space: SPACE, dir, webhookSecret: "s".repeat(32), graceMs: 250 });
  const base = kitFromLibrary("base").includes.types;
  const isCore = (t) => CORE_TYPES.some((c) => c.name === t.name);
  await store.define({ add_types: [...CORE_TYPES] });
  const r = await store.define({ add_types: base.filter((t) => !isCore(t)), change_types: base.filter(isCore) });
  assert.ok(r.changes.some((c) => /^(added|changed) view project\.projects_board$/.test(c)), r.changes.join("; "));
  // the board: a kanban view grouped by the stage field with one group per stage, the fields as view fields
  const board = await readView(client, viewId(SPACE, "project", "projects_board"));
  assert.equal(board.type, "KANBAN");
  assert.ok(board.mainGroupByFieldMetadataId);
  const project = base.find((t) => t.name === "project");
  const stages = project.fields.find((f) => f.kind === "stage").options;
  for (const st of stages) assert.ok(board.viewGroups.some((g) => g.fieldValue === st.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")), `a group for ${st}`);
  assert.deepEqual(board.viewFields.map((f) => f.position).sort((a, b) => a - b), [0, 1, 2, 3]);
  // the calendar and the list with a sort
  const cal = await readView(client, viewId(SPACE, "appointment", "appointments_calendar"));
  assert.equal(cal.type, "CALENDAR"); assert.ok(cal.calendarFieldMetadataId);
  assert.equal(cal.viewFilters.length, 1, "stage != Cancelled is a filter the Records can hold");
  assert.equal(cal.viewFilters[0].operand, "IS_NOT");
  const list = await readView(client, viewId(SPACE, "client", "clients_list"));
  assert.equal(list.type, "TABLE"); assert.deepEqual(list.viewSorts.map((s) => s.direction), ["DESC"]);
  // the fields carry the icon of their kind, and the object's own table lists them in the order of the definition
  const objs = await client.gql("metadata", "query { objects(paging: { first: 200 }) { edges { node { id nameSingular fields(paging: { first: 200 }) { edges { node { id name icon } } } } } } }");
  const lead = objs.objects.edges.map((e) => e.node).find((n) => n.nameSingular === "lead");
  assert.equal(lead.fields.edges.find((e) => e.node.name === "summary").node.icon, "IconNotes");
  const idx = (await client.gql("metadata", "query IV($o: String) { getViews(objectMetadataId: $o) { id key } }", { o: lead.id })).getViews.find((v) => v.key === "INDEX");
  const vfs = (await client.gql("metadata", "query VF($v: String!) { getViewFields(viewId: $v) { fieldMetadataId position isVisible } }", { v: idx.id })).getViewFields;
  const byId = new Map(lead.fields.edges.map((e) => [e.node.id, e.node.name]));
  const mine = ["contact", "source", "summary"];
  const order = vfs.filter((x) => mine.includes(byId.get(x.fieldMetadataId))).sort((a, b) => a.position - b.position).map((x) => byId.get(x.fieldMetadataId));
  assert.deepEqual(order, mine, "the table lists the fields in the order of the definition");
  // changing a view replaces it; removing one destroys it; an expression the Records cannot hold is kept in the definition only
  const client_ = base.find((t) => t.name === "client");
  const changed = await store.define({ change_types: [{ ...client_, views: [{ name: "clients_list", type: "list", columns: ["contact"], filter: "len(stage) > 3" }] }] });
  assert.ok(changed.changes.some((c) => /changed view client.clients_list.*kept in the definition only/.test(c)), changed.changes.join("; "));
  assert.deepEqual((await readView(client, viewId(SPACE, "client", "clients_list"))).viewFields.length, 1);
  const gone = await store.define({ change_types: [{ ...client_, views: [] }] });
  assert.ok(gone.changes.includes("removed view client.clients_list"));
  const after = await readView(client, viewId(SPACE, "client", "clients_list")).catch(() => null);
  assert.ok(!after || after.deletedAt || after.isActive === false, "the removed view is gone from the Records");
});
