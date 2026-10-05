// @ts-check
// A Space's own memory through the gateway: who may file and read is a grant, a fact keeps its source and its filer, and nothing crosses Spaces.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";
import { canonical, sha256 } from "../core/canonical.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OTHER = "spc_bbbbbbbbbbbb", OWNER = "per_owner", BOB = "per_bob";
const key = Buffer.alloc(32, 7);
const sealer = { presenceCheck: async ({ proof, op, fields }) => (proof && proof.op === op && canonical(proof.fields) === canonical(fields) ? null : "wrong_payload") };
const proofFor = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
const boot = async (space = SPACE) => bootKernel({ db: new DatabaseSync(path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-mem-")), "kernel.db")), space, owner: OWNER, owner_uid: 501, key, sealer });
const owner = (k, space = SPACE) => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
const agentOf = (k, name) => k.chains.fromFacts({ kind: "agent_session", agent: name, session: "s", thread: "t", vouched: true });

async function rig(space = SPACE) {
  const k = await boot(space), o = owner(k);
  const role = { person: BOB, role: "member" };
  await k.gateway.grants.setRole(o, role, { presence: proofFor("grants.role", role, `vyre://${space}/member/${BOB}`) });
  await k.gateway.records.define(o, { add_types: [CONTACT] });
  for (const id of ["research", "intake"]) {
    const a = { kind: "agent", id, space };
    await k.gateway.grants.addActor(o, a, { presence: proofFor("grants.role", { actor: a }, `vyre://${space}/member/${id}`) });
  }
  const grant = async (/** @type {string} */ id, /** @type {string[]} */ actions, prefix = `vyre://${space}/memory/*`) => {
    const g = { subject: { kind: "actor", actor: { kind: "agent", id, space } }, actions, resource: { prefix }, conditions: {}, source: "test" };
    return k.gateway.grants.create(o, g, { presence: proofFor("grants.create", g, `vyre://${space}/grant/new`) });
  };
  return { k, o, M: k.gateway.memory, grant, bob: k.chains.fromFacts({ kind: "device", device_key_id: "d-bob", person: BOB, path: "direct" }) };
}

test("memory: an agent files a fact only where a grant lets it, with its source; the filer comes from the chain", async () => {
  const { k, o, M, grant } = await rig();
  const rec = await k.gateway.records.create(o, "contact", { name: "Harlow Legal" });
  const research = agentOf(k, "research");
  await assert.rejects(() => M.file(research, { text: "Harlow Legal pays on the 15th", source: rec.urn }), { code: "not_found" }, "no grant, no write");
  await grant("research", ["memory.file"]);
  await assert.rejects(() => M.file(research, { text: "Harlow Legal pays on the 15th", source: rec.urn }), { code: "not_found" }, "it may file, but may not read the record it names");
  await grant("research", ["records.read"], `vyre://${SPACE}/contact/*`);
  const f = await M.file(research, { text: "Harlow Legal pays on the 15th", source: rec.urn, kind: "policy", topics: ["Billing", "billing", "Harlow"] });
  assert.deepEqual([f.by, f.kind, f.state, f.existing, f.topics], ["agent:research", "policy", "active", false, ["billing", "harlow"]]);
  assert.equal(f.source, rec.urn);
  assert.equal(f.labels.source_spaces[0], SPACE);
  await assert.rejects(() => M.file(research, { text: "x", source: rec.urn, by: "person:per_owner" }), { code: "bad_input" }, "who filed it is not the caller's to say");
  const again = await M.file(research, { text: "Harlow Legal pays on the 15th", source: rec.urn });
  assert.deepEqual([again.id, again.existing], [f.id, true], "the same fact from the same source is one fact");
  const ev = k.log.read({ type: "memory.filed" });
  assert.equal(ev.length, 1);
  assert.ok(!JSON.stringify(ev).includes("pays on the 15th"), "the log carries the text's hash, never the text");
});

test("memory: a source must be in this Space and readable by the filer; placeholders and long text are refused", async () => {
  const { k, o, M, grant } = await rig();
  const secret = await k.gateway.records.create(o, "contact", { name: "Private" });
  await grant("intake", ["memory.file"]);
  const intake = agentOf(k, "intake");
  await assert.rejects(() => M.file(intake, { text: "t", source: secret.urn }), { code: "not_found" }, "the filer may not read that record, so it cannot file about it");
  await assert.rejects(() => M.file(intake, { text: "t", source: `vyre://${OTHER}/contact/${secret.id}` }), { code: "bad_input" }, "another Space's record");
  await assert.rejects(() => M.file(intake, { text: "t", source: "nonsense" }), { code: "bad_input" });
  assert.equal((await M.file(intake, { text: "The intake call ran long", source: "session:s_42#7" })).source, "session:s_42#7");
  await assert.rejects(() => M.file(intake, { text: "ssn is {{field:vyre://x/contact/1#ssn}}", source: "session:s_42" }), { code: "bad_input" });
  await assert.rejects(() => M.file(intake, { text: "x".repeat(2001), source: "session:s_42" }), { code: "bad_input" });
  await assert.rejects(() => M.file(intake, { text: " ", source: "session:s_42" }), { code: "bad_input" });
  await assert.rejects(() => M.file(intake, { text: "t", source: "session:s_42", kind: "gossip" }), { code: "bad_input" });
});

test("memory: the Space's agents read what their grants cover, a member reads, a stranger and a missing grant see nothing", async () => {
  const { k, o, M, grant, bob } = await rig();
  await grant("research", ["memory.file", "memory.read"]);
  const research = agentOf(k, "research"), intake = agentOf(k, "intake");
  const a = await M.file(research, { text: "Fees are billed monthly", source: "session:s1", topics: ["fees"] });
  await M.file(research, { text: "The office closes at 5", source: "session:s1", kind: "note" });
  assert.deepEqual((await M.recall(research, { q: "fees" })).map(x => x.id), [a.id], "an agent with read finds it by words");
  assert.equal((await M.recall(research, { topic: "fees" })).length, 1);
  assert.equal((await M.recall(research, { kind: "note" })).length, 1);
  assert.equal((await M.recall(research, { source: "session:s1" })).length, 2);
  // A grant narrowed to one fact shows only that one.
  await grant("intake", ["memory.read"], `vyre://${SPACE}/memory/${a.id}`);
  assert.deepEqual((await M.recall(intake, {})).map(x => x.id), [a.id], "the other fact is absent, not marked");
  assert.equal((await M.recall(bob, {})).length, 2, "a member reads the Space's memory");
  await assert.rejects(() => M.file(intake, { text: "t", source: "session:s1" }), { code: "not_found" }, "read is not write");
  await assert.rejects(() => M.file(bob, { text: "t", source: "session:s1" }), { code: "not_found" }, "a member does not file");
  const stranger = k.chains.fromFacts({ kind: "device", device_key_id: "d-x", person: "per_nobody", path: "direct" });
  assert.deepEqual(await M.recall(stranger, {}), [], "a stranger sees nothing");
  assert.equal((await M.recall(o, { limit: 1 })).length, 1, "limit caps the answer");
});

test("memory: a fact keeps the labels of its filer's chain, and retiring is the filer's or a person's", async () => {
  const { k, o, M, grant } = await rig();
  await grant("research", ["memory.file", "memory.read", "memory.retire"]);
  await grant("intake", ["memory.file", "memory.read", "memory.retire"]);
  const research = agentOf(k, "research");
  const f = await M.file(research, { text: "Something an outside page said", source: "session:s1" });
  assert.equal(f.labels.trust, research.labels.trust, "the chain's own trust label rides with the fact");
  await assert.rejects(() => M.retire(agentOf(k, "intake"), f.id), { code: "not_allowed" }, "not another agent's fact");
  assert.equal((await M.retire(research, f.id)).state, "retired");
  assert.equal((await M.recall(research, {})).length, 0, "a retired fact is not recalled");
  const g = await M.file(agentOf(k, "intake"), { text: "Another fact", source: "session:s2" });
  assert.equal((await M.retire(o, g.id)).state, "retired", "a person retires any fact");
  await assert.rejects(() => M.retire(o, "does-not-exist"), { code: "not_found" });
});

test("memory: nothing crosses Spaces: a fact filed in one Space is not recalled in another, and a chain of another Space is refused", async () => {
  const a = await rig(SPACE), b = await rig(OTHER);
  await a.grant("research", ["memory.file", "memory.read"]);
  await b.grant("research", ["memory.file", "memory.read"]);
  await a.M.file(agentOf(a.k, "research"), { text: "Only Space A knows the retainer", source: "session:s1" });
  assert.equal((await b.M.recall(agentOf(b.k, "research"), { q: "retainer" })).length, 0, "Space B's memory has nothing from A");
  assert.equal((await a.M.recall(agentOf(a.k, "research"), { q: "retainer" })).length, 1);
  await assert.rejects(() => a.M.recall(agentOf(b.k, "research"), {}), { code: "not_found" }, "a chain built in B asks A: absence");
  await assert.rejects(() => a.M.file(agentOf(b.k, "research"), { text: "x", source: "session:s1" }), { code: "not_found" });
});
