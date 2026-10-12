// A restart on a store whose per-record attributes are NOT kept on disk (the real Twenty store: its `meta` is an in-memory Map that mirrors writes to columns and is empty in a new process), over a durable log that holds
// every record's create event. The log is the authority for who made a record and how sensitive it is; the Map is only a cache. After the restart: the keeper service and the owner still read the kept types' rows (skill,
// def-flow, flow-state, kit-install); a member reads nothing of them by get, query, search, aggregate or the event log; a row marked privileged is not listed to a member; a member's own removed row is still hers in the Bin.
// The same checks run BEFORE the restart as the control. Run on a test box (node:sqlite), never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createKernel } from "../index.js";
import { createSqliteEventLog } from "../store/sqlite-log.js";
import { createSqliteStore } from "../store/sqlite.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const T = (name, extra = {}) => ({ name, label: name, fields: [{ name: "body", kind: "text", label: "Body" }], ...extra });
const TYPES = [T("skill"), T("def-flow", { protected: true }), T("flow-state", { protected: true }), T("kit-install"), T("plain"), T("matter")];

/** A kernel over this database whose store keeps its attributes in a Map that starts EMPTY, as a new process of the Twenty store does. */
async function boot(db) {
  const log = createSqliteEventLog({ db, space: SPACE });
  const real = createSqliteStore({ db });
  const store = Object.create(real, { meta: { value: new Map(), enumerable: true } });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence, store, log });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const skills = k.kernelFor({ name: "skills", needs: { kernel: { actions: ["records.read", "records.create", "records.update"] } } });
  return { k, R: k.gateway.records, owner, bob, skills, keeper: (/** @type {string} */ _m) => skills.serviceChain("skills"), flows: owner };
}

test("after a restart on a store with no durable attributes: the keeper and the owner still read the kept rows, a member reads nothing of them, a privileged row is not listed to her, her own removed row is still hers", { timeout: 120_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-restart-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, "k.db"));
  const a = await boot(db);
  { const r = { person: BOB, role: "member" }; await a.k.gateway.grants.setRole(a.owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${BOB}`) }); }
  await a.R.define(a.owner, { add_types: TYPES });
  const skill = await a.skills.records.create(a.keeper("skills"), "skill", { body: "SKILL-BODY-ONE" });
  const flow = await a.R.create(a.flows, "def-flow", { body: "FLOW-BODY-ONE" });
  const state = await a.R.create(a.flows, "flow-state", { body: "STATE-BODY-ONE" });
  const kit = await a.R.create(a.owner, "kit-install", { body: "KIT-BODY-ONE" });
  const secret = await a.R.create(a.owner, "matter", { body: "PRIVILEGED-MATTER-BODY" }, { attrs: { sensitivity: "privileged" } });
  const open = await a.R.create(a.owner, "matter", { body: "ordinary matter" });
  const mine = await a.R.create(a.bob, "plain", { body: "BOBS-OWN" });
  await a.R.remove(a.bob, "plain", mine.id, mine.version);
  const rows = { skill: skill.id, "def-flow": flow.id, "flow-state": state.id, "kit-install": kit.id };

  const check = async (/** @type {any} */ w, /** @type {string} */ when) => {
    // search first, before any get: the owner and the keeper find their rows
    assert.ok((await w.R.search(w.owner, { text: "BODY-ONE", page: { limit: 20 } })).rows.some((/** @type {any} */ h) => h.type === "def-flow"), `${when}: the owner finds the def-flow row by search`);
    assert.ok((await w.skills.records.search(w.keeper("skills"), { text: "SKILL-BODY-ONE", page: { limit: 20 } })).rows.some((/** @type {any} */ h) => h.type === "skill"), `${when}: the keeper finds its skill row by search`);
    // the keeper and the owner read each kept row
    for (const [type, id] of Object.entries(rows)) {
      const who = type === "skill" ? w.keeper("skills") : type === "kit-install" ? w.owner : w.flows;
      const RR = type === "skill" ? w.skills.records : w.R;
      // (a list first: nothing has asked about this row yet, so nothing has put its attributes back in the Map)
      assert.equal((await RR.query(who, type, { page: { limit: 10 } })).rows.length, 1, `${when}: the keeper lists its ${type} row`);
      assert.equal((await w.R.query(w.owner, type, { page: { limit: 10 } })).rows.length, 1, `${when}: the owner lists it`);
      assert.ok(await RR.get(who, type, id), `${when}: the keeper reads its ${type} row by id`);
      assert.ok(await w.R.get(w.owner, type, id), `${when}: the owner reads the ${type} row`);
    }
    // a member reads nothing of them
    for (const [type, id] of Object.entries(rows)) {
      assert.equal(await w.R.get(w.bob, type, id), null, `${when}: a member gets no ${type} row`);
      assert.deepEqual((await w.R.query(w.bob, type, { page: { limit: 10 } })).rows, [], `${when}: lists none`);
      assert.deepEqual(await w.R.aggregate(w.bob, type, { measures: [{ fn: "count" }] }), [], `${when}: counts none`);
    }
    assert.equal((await w.R.search(w.bob, { text: "BODY-ONE", page: { limit: 20 } })).rows.filter((/** @type {any} */ h) => h.type in rows).length, 0, `${when}: finds none by search`);
    const events = await w.k.gateway.events.read(w.bob, {});
    assert.ok(!events.some((/** @type {any} */ e) => Object.keys(rows).some(ty => String(e.subject).includes(`/${ty}/`))), `${when}: and sees no event about them`);
    // a privileged row is not listed to a member (presence is what reading it needs), nor counted, nor found
    const listed = (await w.R.query(w.bob, "matter", { page: { limit: 20 } })).rows.map((/** @type {any} */ r) => r.id);
    assert.ok(!listed.includes(secret.id), `${when}: the privileged matter is not listed to a member`);
    assert.ok(listed.includes(open.id), `${when}: the ordinary one is`);
    const count = await w.R.aggregate(w.bob, "matter", { measures: [{ fn: "count" }] });
    assert.equal(JSON.stringify(count).includes('"count":2') , false, `${when}: the member's count does not include the privileged matter: ${JSON.stringify(count)}`);
    assert.equal((await w.R.search(w.bob, { text: "PRIVILEGED-MATTER-BODY", page: { limit: 5 } })).rows.length, 0, `${when}: nor found by search`);
    // her own removed row is still hers in the Bin
    const bin = await w.R.query(w.bob, "plain", { include_deleted: true, page: { limit: 10 } });
    assert.ok(bin.rows.some((/** @type {any} */ r) => r.id === mine.id), `${when}: a member's own removed row is still in her Bin`);
  };

  await check(a, "before the restart");
  db.close();
  const db2 = new DatabaseSync(path.join(dir, "k.db"));
  const b = await boot(db2);
  assert.equal(b.k.store.meta.size, 0, "the restarted store's attribute map is empty");
  await check(b, "after the restart");
});

// ---- the attribute-restricted caller (a member whose read grant is `project = p1`): the store counts and lists under a pushed predicate ONLY where no record of the type is privileged (records.js attrFilterFor). The
// gateway's answer to "is any record privileged" must survive a restart, when the store's attribute Map is empty and the log is the only memory of who marked what.
import { createGateway } from "./index.js";
import { createChainBuilder } from "../core/chain.js";
test("a restart does not make a privileged row look ordinary to an attribute-restricted member (list, count, search)", { timeout: 120_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-restart2-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let T = 1_800_000_000_000; const clock = () => ++T;
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
  const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const member = () => chains.fromFacts({ kind: "invitee", person: BOB, vouched: true });
  const actor = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
  let n = 0;
  const G = (/** @type {string} */ who, over = {}) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actor(who) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active", ...over });
  const grants = [G(OWNER), G(BOB, { actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/matter/*`, where: [{ attr: "project", op: "eq", value: "p1" }] } })];
  const all = new Map(grants.map(g => [g.id, g]));
  const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }] };
  const open = (/** @type {string} */ file) => {
    const db = new DatabaseSync(file);
    const log = createSqliteEventLog({ db, space: SPACE, clock });
    const real = createSqliteStore({ db, clock });
    const store = Object.create(real, { meta: { value: new Map(), enumerable: true } });   // the attribute Map of a store that does not keep them on disk: empty in a new process
    const known = new Set([`person:${OWNER}`, `person:${BOB}`]);
    const gw = createGateway({ space: SPACE, store, log, chains, clock, attrs: () => ({}), attrPush: () => true,
      grants: { forSubject: (/** @type {any} */ a) => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: (/** @type {string} */ id) => all.get(id) },
      members: { has: (/** @type {any} */ a) => known.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => false });
    return { db, gw, store };
  };
  const file = path.join(dir, "k2.db");
  const a = open(file);
  await a.gw.records.define(owner(), { add_types: [MATTER] });
  const ordinary = await a.gw.records.create(owner(), "matter", { title: "ordinary" }, { attrs: { project: "p1" } });
  const secret = await a.gw.records.create(owner(), "matter", { title: "PRIVILEGED-TITLE" }, { attrs: { project: "p1", sensitivity: "privileged" } });
  const view = async (/** @type {any} */ w, /** @type {string} */ when) => {
    const ids = (await w.gw.records.query(member(), "matter", { page: { limit: 20 } })).rows.map((/** @type {any} */ r) => r.id);
    assert.ok(ids.includes(ordinary.id), `${when}: the member lists the ordinary row of her project`);
    assert.ok(!ids.includes(secret.id), `${when}: and not the privileged one`);
    const count = JSON.stringify(await w.gw.records.aggregate(member(), "matter", { measures: [{ fn: "count" }] }));
    assert.ok(!count.includes(":2"), `${when}: her count leaves the privileged row out: ${count}`);
    const hits = (await w.gw.records.search(member(), { text: "PRIVILEGED-TITLE", types: ["matter"], page: { limit: 5 } })).rows;
    assert.equal(hits.length, 0, `${when}: and a search does not find it`);
  };
  await view(a, "before the restart");
  a.db.close();
  const b = open(file);
  assert.equal(b.store.meta.size, 0, "the restarted store's attribute map is empty");
  await view(b, "after the restart");
});
