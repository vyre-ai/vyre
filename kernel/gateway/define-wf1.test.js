// WF-1 on records.define. (header from kq-fixes) (reviewer-2, 25f5ccb20), each with its attack: KQ-1 no grant on the type must not total it, KQ-2 the slow aggregate path is bounded, KQ-3 index slots cannot be squatted, KQ-4 a page limit is validated.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
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
const make = (grants, attrs = () => ({}), kind = "memory", over = {}) => {
  const db = new DatabaseSync(":memory:");
  const store = createMemoryStore({ clock });
  const log = createEventLog({ space: SPACE, clock });
  const all = new Map(grants.map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, `person:${MEMBER}`]);
  const wlog = over.wrap ? over.wrap(log) : log;
  const gw = createGateway({ space: SPACE, store, log: wlog, chains, clock, attrs,
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members: { has: a => known.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  return { store, gw, db };
};

for (const kind of ["memory"]) {
  test(`WF-1 (${kind}): a type definition whose event the log refuses is not left defined (new type removed, changed type put back), and a retry works`, async () => {
    let fail = false;
    const { store, gw } = make([G(OWNER)], () => ({}), kind, { wrap: real => ({ ...real, append: (...a) => { if (fail && a[1] && a[1].type === "types.defined") throw new Error("log refused"); return real.append(...a); } }) });
    const names = async () => (await store.types()).map(t => t.name).sort();
    await gw.records.define(owner(), { add_types: [NOTE] });
    fail = true;
    await assert.rejects(() => gw.records.define(owner(), { add_types: [MATTER] }), /log refused/);
    assert.deepEqual(await names(), ["note"], "the new type is gone");
    const wider = { ...NOTE, fields: [...NOTE.fields, { name: "extra", kind: "text", label: "Extra" }] };
    await assert.rejects(() => gw.records.define(owner(), { change_types: [wider] }), /log refused/);
    assert.deepEqual((await store.types()).find(t => t.name === "note").fields.map(f => f.name), ["body"], "the changed type is as it was");
    fail = false;
    assert.equal((await gw.records.define(owner(), { add_types: [MATTER] })).applied, true);
    assert.deepEqual(await names(), ["matter", "note"]);
  });
}
