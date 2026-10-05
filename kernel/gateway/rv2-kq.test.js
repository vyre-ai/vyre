// reviewer-2 repros for kernel-query 25f5ccb20: KQ-1 (no grant on the type still totals it), KQ-2 (slow aggregate path holds every row).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createGateway } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", MEMBER = "per_member";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const member = () => chains.fromFacts({ kind: "invitee", person: MEMBER, vouched: true });
const actor = (id) => ({ kind: "person", id, space: SPACE });
let n = 0;
const G = (who, over = {}) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actor(who) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active", ...over });
const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open", "closed"] }, { name: "fee", kind: "number", label: "Fee" }] };
const NOTE = { name: "note", label: "Note", fields: [{ name: "body", kind: "text", label: "Body" }] };
const make = (grants, attrs = () => ({})) => {
  const store = createMemoryStore({ clock });
  const log = createEventLog({ space: SPACE, clock });
  const all = new Map(grants.map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, `person:${MEMBER}`]);
  const gw = createGateway({ space: SPACE, store, log, chains, clock, attrs,
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members: { has: a => known.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  return { store, gw };
};

test("KQ-1: a member whose grants cover only note totals matter (must be empty)", async () => {
  const { store, gw } = make([G(OWNER), G(MEMBER, { actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/note/*` } })]);
  await gw.records.define(owner(), { add_types: [MATTER, NOTE] });
  for (let i = 0; i < 9; i++) await gw.records.create(owner(), "matter", { title: `Harlow ${i}`, stage: ["intake", "open", "closed"][i % 3], fee: 100 + i });
  const before = store.stats().aggregate_pushed;
  const r = await gw.records.aggregate(member(), "matter", { group_by: ["stage"], measures: [{ fn: "count" }, { fn: "sum", field: "fee" }] });
  console.log("KQ-1 result for the no-grant member:", JSON.stringify(r), "pushed:", store.stats().aggregate_pushed - before);
  assert.deepEqual(r, [], "a caller with no read grant on the type must see nothing");
});

test("KQ-2: a restricted caller's total over 60k rows holds them all (heap growth)", async () => {
  const { store, gw } = make([G(OWNER), G(MEMBER, { actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/matter/*`, where: [{ attr: "project", op: "eq", value: "p1" }] } })], () => ({ project: "p1" }));
  await gw.records.define(owner(), { add_types: [MATTER] });
  for (let i = 0; i < 60000; i++) await store.create("matter", randomUUID(), { title: `Harlow ${i}`, stage: ["intake", "open", "closed"][i % 3], fee: i });
  global.gc && global.gc();
  const base = process.memoryUsage().heapUsed;
  let pages = 0, peak = 0;
  const q = store.query.bind(store);
  store.query = async (...a) => { pages++; peak = Math.max(peak, process.memoryUsage().heapUsed - base); return q(...a); };
  let out;
  try { out = await gw.records.aggregate(member(), "matter", { group_by: ["stage"], measures: [{ fn: "count" }] }); } catch (e) { out = "THROWN " + e.code + ": " + e.message; }
  console.log("KQ-2 pages:", pages, "peak heap growth MB:", (peak / 1048576).toFixed(1), "result:", JSON.stringify(out));
  assert.ok(pages <= 40 || typeof out === "string", "the old cap was 40 pages (20,000 rows): beyond it must refuse or fold, not collect");
});
