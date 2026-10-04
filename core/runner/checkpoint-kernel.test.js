// The checkpoint store against the REAL kernel authorizer: the two actions are registered, no role reaches them, and a grant on one session's own urn
// opens that session and no other (reviewer-2 RN-5).
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { createCheckpointStore } from "./checkpoint-store.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };

test("registered, in no role, and granted per session to that session's own chain", async t => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  const r = { person: BOB, role: "member" }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${BOB}`) });
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const urn = id => `vyre://${SPACE}/session/${id}`;
  const gi = { subject: { kind: "actor", actor: kit }, actions: ["checkpoint.write", "checkpoint.read"], resource: { prefix: urn("s1") }, conditions: {}, source: "test" };
  const asst = () => k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "kit", session: "s1" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const decide = (chain, action, id) => k.gateway.authorize({ chain, action, resource: urn(id) });

  for (const a of ["checkpoint.write", "checkpoint.read"]) {
    assert.notEqual((await decide(owner, a, "s1")).reason, "unknown_action", `${a} is registered`);
    assert.equal((await decide(bob, a, "s1")).effect, "deny", "a member's role does not reach a session's history");
  }
  const made = await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) }); 
  { const d = await decide(asst(), "checkpoint.write", "s1"); assert.equal(d.effect, "allow", `the session's own chain, on its own session (${d.reason})`); }

  const dir = fs.mkdtempSync(path.join(SCRATCH, "ck-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createCheckpointStore({ space: SPACE, root: dir, authorize: i => k.gateway.authorize(i) });
  // the person's default assistant acting for them (entered from a surface, no session of its own) never reaches a session's history, even with the owner's role behind it
  const delegated = k.chains.fromFacts({ kind: "socket", surface: "mcp", uid: 501 });
  for (const c of [delegated]) { try { await store.appendTranscript(c, "s1", [{ seq: 9, line: "x" }]); assert.fail("accepted"); } catch (e) { assert.equal(e.code, "not_found"); } }
  assert.deepEqual(await store.appendTranscript(asst(), "s1", [{ seq: 1, line: "a" }]), { acked: 1 });
  await assert.rejects(store.appendTranscript(asst(), "s2", [{ seq: 1, line: "a" }]), { code: "not_found" }, "another session is not reachable with it");
  await assert.rejects(store.appendTranscript(bob, "s1", [{ seq: 1, line: "a" }]), { code: "not_found" });
});
