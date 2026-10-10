// @ts-check
// A lent-computer world for tests: a real kernel with its Offers and leases (a fake sealing process), the lent home service behind the kernel's remote server, and clients that reach it through the in-memory
// stand-in for Wink. lent-wire.test.js drives the wire with it; the module and chaos tests drive a runner against it.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../../test/scratch.mjs";
import { createKernel } from "../../../kernel/index.js";
import { canonical, sha256 } from "../../../kernel/core/canonical.js";
import { createRemoteServer } from "../../../kernel/remote/server.js";
import { createRemoteKernel } from "../../../kernel/remote/client.js";
import { createMemoryTransport } from "../../../kernel/remote/memory-transport.js";
import { createLentHome } from "../lent-home.js";
import { createLentClient } from "../lent-client.js";

export const SPACE = "spc_aaaaaaaaaaaa";
export const OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol";
export const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
function fakeSealer() {
  const st = { live: new Map(), revoked: new Set() }; let n = 0;
  const one = c => { if (!c || c.hops.length !== 1 || c.hops[0].actor.kind !== "person") throw Object.assign(new Error("human_only"), { code: "human_only" }); };
  return { st, lease: {
    // like the real process, issue gives the same member and computer the same key while access holds
    issue: async i => { one(i.chain); const m = i.chain.hops[0].actor.id; if (!i.allowed || st.revoked.has(`${m}|${i.device}`)) return { revoked: true }; const id = `lease_${++n}`; st.live.set(id, `${m}|${i.device}`); return { id, key: crypto.createHash("sha256").update(`${m}|${i.device}`).digest("base64"), ttlMs: 3600000 }; },
    renew: async i => { one(i.chain); if (!i.allowed) return { revoked: true }; return { ttlMs: 3600000 }; },
    revoke: async i => { one(i.chain); st.revoked.add(`${i.member}|${i.device}`); return { revoked: true }; },
    reinstate: async () => ({ reinstated: true }),
    check: async i => { if (!st.live.has(i.id)) throw Object.assign(new Error("no_lease: ask the home to lend this computer again"), { code: "no_lease" }); const [member, device] = st.live.get(i.id).split("|"); return { space: SPACE, member, device }; },
  } };
}

export async function rig(t, o = {}) {
  const acceptCap = o.acceptCap;
  const keyOf = o.keyIsDevice ? "dev_laptop" : "KEY_LAPTOP";
  const dir = fs.mkdtempSync(path.join(SCRATCH, "lw-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sealer = fakeSealer();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence, resolveCredential: async () => ({ secret: "v" }) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "dev_laptop", person: BOB, path: "direct" });
  const g = k.gateway.grants;
  for (const p of [BOB, CAROL]) { const role = { person: p, role: "member" }; await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${p}`) }); }
  const mk = (chain, x) => g.offers.offer(chain, x, { presence: proof("grants.offer", x, `vyre://${SPACE}/offer/new`) });
  await mk(owner, { side: "space_allows", member: BOB });
  const accept = await mk(bob, { side: "member_accepts", member: BOB, device: "dev_laptop", device_key: keyOf, ...(acceptCap ? { network_cap: acceptCap } : {}) });
  const home = createLentHome({ space: SPACE, root: path.join(dir, "home"), offers: g.offers, ...(o.canResume ? { canResume: o.canResume } : {}), ...(o.http ? { http: o.http } : {}), ...(o.httpFirstMs ? { httpFirstMs: o.httpFirstMs } : {}), ...(o.callMaxMs ? { callMaxMs: o.callMaxMs } : {}), ...(o.emit ? { emit: o.emit } : {}), chatHas: (chain, id) => { try { g.chats.read(chain, id); return true; } catch { return false; } }, leases: k.gateway.leases, lenderCap: () => o.cap, ...(o.now ? { now: o.now } : {}), ...(o.lapseMs ? { lapseMs: o.lapseMs } : {}), ...(o.resume ? { resume: o.resume } : {}), ...(o.emit ? { emit: o.emit } : {}),
    specFor: o.specFor || (async ({ session }) => ({ command: "/usr/bin/agent", args: [session], env: {}, routes: [], readOnly: [], labels: {}, network: "internet", credentialRoutes: [{ route: "api.example.com", ref: "svc", paths: ["/v1/*"] }] })) });
  const server = createRemoteServer({ space: SPACE, kernel: k, services: { lent: home } });
  const as = (person, device) => { const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: server }, peer: { device_key_id: device, person, path: "wink" } }) }); return createLentClient({ invoke: remote.call, device, deviceKey: "KEY_LAPTOP" }); };
  return { k, owner, bob, g, mk, accept, home, server, sealer, as, dir };
}

