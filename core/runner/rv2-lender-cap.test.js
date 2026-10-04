// The lent-computer wire on the REAL kernel: a member's computer runs one of the Space's sessions through the kernel's remote call (the in-memory stand-in for Wink), with the real Offers,
// the real leases and the real remote server on the home side, and the lent home service in front of the checkpoint store. Every refusal in docs/work/runner.md is a test here.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { createMemoryTransport } from "../../kernel/remote/memory-transport.js";
import { createLentHome, CHUNK_BYTES } from "./lent-home.js";
import { createLentClient } from "./lent-client.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
function fakeSealer() {
  const st = { live: new Map(), revoked: new Set() }; let n = 0;
  const one = c => { if (!c || c.hops.length !== 1 || c.hops[0].actor.kind !== "person") throw Object.assign(new Error("human_only"), { code: "human_only" }); };
  return { st, lease: {
    issue: async i => { one(i.chain); const m = i.chain.hops[0].actor.id; if (!i.allowed || st.revoked.has(`${m}|${i.device}`)) return { revoked: true }; const id = `lease_${++n}`; st.live.set(id, `${m}|${i.device}`); return { id, key: crypto.randomBytes(32).toString("base64"), ttlMs: 3600000 }; },
    renew: async i => { one(i.chain); if (!i.allowed) return { revoked: true }; return { ttlMs: 3600000 }; },
    revoke: async i => { one(i.chain); st.revoked.add(`${i.member}|${i.device}`); return { revoked: true }; },
    reinstate: async () => ({ reinstated: true }),
    check: async i => { if (!st.live.has(i.id)) throw Object.assign(new Error("no_lease"), { code: "no_lease" }); const [member, device] = st.live.get(i.id).split("|"); return { space: SPACE, member, device }; },
  } };
}

async function rig(t, o = {}) {
  const acceptCap = o.acceptCap;
  const dir = fs.mkdtempSync(path.join(SCRATCH, "lw-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sealer = fakeSealer();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence, resolveCredential: async () => ({ secret: "v" }) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "dev_laptop", person: BOB, path: "direct" });
  const g = k.gateway.grants;
  for (const p of [BOB, CAROL]) { const role = { person: p, role: "member" }; await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${p}`) }); }
  const mk = (chain, x) => g.offers.offer(chain, x, { presence: proof("grants.offer", x, `vyre://${SPACE}/offer/new`) });
  await mk(owner, { side: "space_allows", member: BOB });
  const accept = await mk(bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP", ...(acceptCap ? { network_cap: acceptCap } : {}) });
  const home = createLentHome({ space: SPACE, root: path.join(dir, "home"), offers: g.offers, leases: k.gateway.leases, lenderCap: () => o.cap,
    specFor: async ({ session }) => ({ command: "/usr/bin/agent", args: [session], env: {}, routes: [], readOnly: [], labels: {}, network: "internet", credentialRoutes: [{ route: "api.example.com", ref: "svc", paths: ["/v1/*"] }] }) });
  const server = createRemoteServer({ space: SPACE, kernel: k, services: { lent: home } });
  const as = (person, device) => { const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: server }, peer: { device_key_id: device, person, path: "wink" } }) }); return createLentClient({ invoke: remote.call, device, deviceKey: "KEY_LAPTOP" }); };
  return { k, owner, bob, g, mk, accept, home, server, sealer, as, dir };
}
// ---- reviewer-2 probes on work/runner 037500d2e: the lender's cap (CAP-1, CAP-2, CAP-3). Drop into core/runner/. ----
const lendProof = (o, res) => proof("grants.offer", { lend: { member: o.member, device: o.device, device_key: o.device_key } }, res);

test("CAP-2: a member's later, tighter acceptance is not what capOf reads (first active wins, undefined counts as an answer)", async t => {
  const r = await rig(t);                                             // BOB already has an acceptance with no cap
  const x = { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP", network_cap: "provider" };
  await r.mk(r.bob, x).catch(e => console.log("second offer refused:", e.code));
  const cap = r.g.offers.capOf({ member: BOB, device: "dev_laptop" });
  console.log("CAP-2 capOf after a tighter second acceptance:", cap);
  assert.equal(cap, "provider", "the lender tightened their own cap; the looser older acceptance must not win");
});

test("CAP-1: the lend proof does not bind network_cap, so the cap can be dropped or changed after the member signed", async t => {
  const r = await rig(t);
  await r.g.offers.unoffer?.(r.bob, { id: r.accept.id }, {}).catch(() => {});
  const o = { member: BOB, device: "dev_new", device_key: "KEY_NEW" };
  const res = `vyre://${SPACE}/offer/lend`;
  // the member's screen asks for provider; the proof can only be over the cap-less form
  const withCap = await r.g.offers.lend(r.bob, { ...o, network_cap: "provider" }, { presence: lendProof(o, res) }).catch(e => ({ error: e.code }));
  const r2 = await rig(t);
  const noCap = await r2.g.offers.lend(r2.bob, { ...o }, { presence: lendProof(o, res) }).catch(e => ({ error: e.code }));
  const r3 = await rig(t);
  const other = await r3.g.offers.lend(r3.bob, { ...o, network_cap: "internet" }, { presence: lendProof(o, res) }).catch(e => ({ error: e.code }));
  console.log("CAP-1 same proof: provider", JSON.stringify(withCap).slice(0, 80), "| none", JSON.stringify(noCap).slice(0, 80), "| internet", JSON.stringify(other).slice(0, 80));
  assert.ok(withCap.error || noCap.error || other.error, "one proof must not carry three different caps");
});

test("CAP-3: lend of an already-accepted computer with a cap neither applies it nor says so", async t => {
  const r = await rig(t);                                             // dev_laptop already accepted, no cap
  const o = { member: BOB, device: "dev_laptop", device_key: "KEY_LAPTOP" };
  const res = `vyre://${SPACE}/offer/lend`;
  const out = await r.g.offers.lend(r.bob, { ...o, network_cap: "provider" }, { presence: lendProof(o, res) }).catch(e => ({ error: e.code }));
  const cap = r.g.offers.capOf({ member: BOB, device: "dev_laptop" });
  console.log("CAP-3 lend result", JSON.stringify(out).slice(0, 100), "cap now", cap);
  assert.ok(out.error || cap === "provider", "a requested cap must apply or be refused, never dropped silently");
});
