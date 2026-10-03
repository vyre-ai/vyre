import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { createDoor } from "../door/door.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const agent = () => chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
const actor = (kind, id) => ({ kind, id, space: SPACE });
const REC = `vyre://${SPACE}/contact/0190c3f2-1111-4abc-8def-000000000000`;
let n = 0;
const G = (actions, subject = actor("person", OWNER)) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: subject }, actions, action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: actor("person", OWNER), source: "test", status: "active", created_at: 0 });

function rig(extra = {}) {
  const calls = [];
  const sealer = {
    api: { put: async i => { calls.push(["put", i]); return { sealed: "ssn", ref: "sv_1", present: true, valid_format: true, set_at: 1 }; }, use: async i => { calls.push(["use", i]); return { merged: true, output_ref: "d_1" }; }, reveal: async i => { calls.push(["reveal", i]); return { value: "x", expires_in_ms: 1 }; } },
    deliver: async i => { calls.push(["deliver", i]); return { sent: true }; },
  };
  const grants = [G(["seal.put", "seal.use", "seal.reveal", "seal.deliver"]), G(["seal.put", "seal.use"], actor("agent", "kit"))];
  const known = new Set([`person:${OWNER}`, "agent:kit"]);
  const log = createEventLog({ space: SPACE, clock });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, sealer, hasPresenceSession: () => true,
    grants: { forSubject: a => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => grants.find(g => g.id === id) },
    members: { has: a => known.has(`${a.kind}:${a.id}`) }, ...extra });
  return { gw, calls };
}

test("sealing wiring: a hand-made chain is refused before the process is touched", async () => {
  const { gw, calls } = rig();
  await assert.rejects(() => gw.seal.put({ space: SPACE, hops: [{ actor: actor("person", OWNER) }] }, { record: REC, field: "ssn", class: "us-ssn", value: "x" }), { code: "bad_input" });
  assert.equal(calls.length, 0);
});

test("sealing wiring: put goes through authorize; reveal needs the grant, which a model's chain lacks", async () => {
  const { gw, calls } = rig();
  assert.equal((await gw.seal.put(owner(), { record: REC, field: "ssn", class: "us-ssn", value: "123-45-6789" })).ref, "sv_1");
  await assert.rejects(() => gw.seal.reveal(agent(), { record: REC, ref: "sv_1", purpose: "x", proof: {} }), { code: "not_found" });
  assert.deepEqual(calls.map(c => c[0]), ["put"]);
});

test("sealing wiring: use takes destination, approver, proof and template body from the kernel's records, not the call", async () => {
  const approver = owner();
  const approvals = { get: async id => (id === "ap1" ? { approver_chain: approver, proof: { sig: "p" }, template: `vyre://${SPACE}/template/t`, template_version: 3, record: REC, slot: "ssn", ref: "sv_1" } : null) };
  const templates = { get: async (u, v) => (v === 3 ? { body: "SSN {{sealed:ssn}}" } : null) };
  const destinations = { resolve: async (record) => ({ kind: "contact_point", record, contact: "jane@harlow.test", verified: true }) };
  const { gw, calls } = rig({ approvals, templates, destinations });
  await gw.seal.use(agent(), { record: REC, approval: "ap1", destination: { kind: "contact_point", contact: "evil@x.test", verified: true }, body: "attacker {{sealed:ssn}}", proof: { sig: "forged" } });
  const [, got] = calls[0];
  assert.equal(got.destination.contact, "jane@harlow.test");
  assert.equal(got.body, "SSN {{sealed:ssn}}");
  assert.deepEqual(got.proof, { sig: "p" });
  assert.equal(got.approver_chain, approver);
  await assert.rejects(() => gw.seal.use(agent(), { record: REC, approval: "nope" }), { code: "not_found" });
});

test("sealing wiring: without approvals, templates and destinations wired, use stays closed", async () => {
  const { gw } = rig();
  await assert.rejects(() => gw.seal.use(agent(), { record: REC, approval: "ap1" }), { code: "unavailable" });
});

test("sealing wiring: the door takes the kernel's own isChain", async () => {
  const door = createDoor({ sealer: { detect: async () => ({ text: "", found: [], ledger: [] }), endSession: async () => {} }, drivers: {}, sinks: [], isChain: c => c === "kernel-chain" });
  await assert.rejects(() => door.call({ chain: { space: SPACE, hops: [{ actor: { kind: "agent", id: "a" } }] }, messages: [{ role: "user", content: "x" }] }), TypeError);
});
