import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../test/scratch.mjs";
import { bootKernel } from "./boot.js";
import { canonical, sha256 } from "./core/canonical.js";
import { CONTACT } from "./conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const key = Buffer.alloc(32, 7);
const file = () => path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-boot-")), "kernel.db");
const sealer = { presenceCheck: async ({ proof, op, fields }) => (proof && proof.op === op && canonical(proof.fields) === canonical(fields) ? null : "wrong_payload") };
const proofFor = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
const boot = f => bootKernel({ db: new DatabaseSync(f), space: SPACE, owner: OWNER, owner_uid: 501, key, sealer });
const ownerChain = k => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });

test("boot: a first start makes the owner; a restart brings back every grant, member, record and event from the home's database", async () => {
  const f = file();
  let k = await boot(f);
  assert.equal(k.fresh, true);
  const o = ownerChain(k);
  await k.gateway.records.define(o, { add_types: [CONTACT] });
  const bob = { kind: "person", id: "per_bob", space: SPACE };
  const role = { person: "per_bob", role: "member" };
  await k.gateway.grants.setRole(o, role, { presence: proofFor("grants.role", role, `vyre://${SPACE}/member/per_bob`) });
  const c = await k.gateway.records.create(o, "contact", { name: "Jane" });
  assert.equal(k.grants.roleOf(bob), "member");
  const events = k.log.latestSeq();
  // restart: a new process on the same file
  k = await boot(f);
  assert.equal(k.fresh, false);
  assert.equal(k.grants.roleOf(bob), "member", "memberships come back from the log");
  assert.equal(k.grants.roleOf({ kind: "person", id: OWNER, space: SPACE }), "owner");
  assert.equal(k.log.latestSeq(), events);
  assert.equal((await k.gateway.audit.verify()).ok, true);
  assert.equal((await k.gateway.records.get(ownerChain(k), "contact", c.id)).data.name, "Jane", "records come back from the store");
  // bob can work on the restarted kernel with the grants the role gave him
  const bobChain = k.chains.fromFacts({ kind: "device", device_key_id: "d-bob", person: "per_bob", path: "direct" });
  assert.equal((await k.gateway.records.create(bobChain, "contact", { name: "Made after restart" })).data.name, "Made after restart");
});

import { createKernel } from "./index.js";
test("createKernel: one call wires everything with safe defaults, including the rule evaluator", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key });
  const o = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await k.gateway.records.define(o, { add_types: [{ name: "deal", label: "Deal", fields: [{ name: "stage", kind: "stage", label: "Stage", options: ["A", "B"] }, { name: "ok", kind: "boolean", label: "Ok" }], stages: [{ name: "A" }, { name: "B" }], rules: [{ name: "r", require: "stage < 'B' or ok == true" }] }] });
  await assert.rejects(() => k.gateway.records.create(o, "deal", { stage: "B", ok: false }), { code: "rule_failed" });
  assert.equal((await k.gateway.records.create(o, "deal", { stage: "B", ok: true })).data.stage, "B");
  assert.equal(k.fresh, true);
  assert.equal((await k.gateway.audit.verify()).ok, true);
});

test("surfaces: a daemon presents a token; the kernel mints the chain for that session's person and assistant; the token cannot be forged, moved or outlive its session", async () => {
  let now = 1_800_000_000_000;
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key, clock: () => now });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct" });
  const S = k.surfaces;
  const { token, session } = await S.open(owner, { thread: "t1" });
  const c = await S.chainFor(token);
  assert.deepEqual(c.hops.map(h => [h.actor.kind, h.actor.id]), [["person", OWNER]]);
  assert.equal(c.hops[0].via.session, undefined, "a daemon's session is not a presence session");
  const a = await S.chainFor((await S.open(owner, { agent: "kit", thread: "t1" })).token);
  assert.deepEqual(a.hops.map(h => h.actor.kind), ["person", "agent"]);
  // forged, edited, expired, revoked, and someone else's
  const [body, mac] = token.split(".");
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url")), person: "per_evil" })).toString("base64url");
  for (const bad of [`${evil}.${mac}`, `${body}.AAAA`, "nonsense", "", undefined]) await assert.rejects(() => S.chainFor(bad), { code: "not_a_member" });
  S.revoke(session);
  await assert.rejects(() => S.chainFor(token), { code: "not_a_member" });
  const short = (await S.open(owner, { ttl_ms: 1000 })).token;
  now += 2000;
  await assert.rejects(() => S.chainFor(short), { code: "not_a_member" });
  const agent = k.chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
  await assert.rejects(() => S.open(agent), { code: "chain_not_person" }, "a model does not open sessions");
  // ctx.model: the door's call runs under the session's chain, and a door with no stream says so
  const seen = [];
  const k2 = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key, door: { usesKernelChain: true, call: async i => { seen.push(i.chain.hops.map(h => h.actor.kind)); return { content: "ok" }; } } });
  const o2 = k2.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct" });
  const t2 = (await k2.surfaces.open(o2, { agent: "kit" })).token;
  assert.equal((await k2.surfaces.model.call(t2, { messages: [] })).content, "ok");
  assert.deepEqual(seen, [["person", "agent"]]);
  await assert.rejects(async () => { for await (const _ of k2.surfaces.model.stream(t2, {})) void _; }, { code: "unsupported" }, "a door with no streaming call says so");
  // a door with streaming: the chain is the session's, and the events come through as the door yields them
  const chains2 = [];
  const k3 = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key, door: { usesKernelChain: true, call: async () => ({}), async *stream(i) { chains2.push(i.chain.hops.map(h => h.actor.kind)); yield { type: "text", text: "he" }; yield { type: "text", text: "llo" }; yield { type: "done" }; } } });
  const t3 = (await k3.surfaces.open(k3.chains.fromFacts({ kind: "device", device_key_id: "d", person: OWNER, path: "direct" }), { agent: "kit" })).token;
  const got = [];
  for await (const ev of k3.surfaces.model.stream(t3, { messages: [] })) got.push(ev.type === "text" ? ev.text : ev.type);
  assert.deepEqual(got, ["he", "llo", "done"]);
  assert.deepEqual(chains2, [["person", "agent"]]);
  await assert.rejects(async () => { for await (const _ of k3.surfaces.model.stream("forged.token", {})) void _; }, { code: "not_a_member" });
});
