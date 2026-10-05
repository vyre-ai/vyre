// Where the time goes on a real Twenty: provision a Space, then time the first define of the core types and N record creates, counting every call by operation.
// Run on a test box: node stores/twenty/live/profile.mjs <space> [records, default 40]   (then: docker compose -p vyre-<space>-twenty down -v)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionSpace, spaceDir, realRunner } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { mintUuid } from "../../../kernel/core/ids.js";
import { TwentyClient } from "../client.js";
import { CORE_TYPES } from "../../../records/core-types.js";
import { createKernel } from "../../../kernel/index.js";

const space = process.argv[2] ?? "prof", N = Number(process.argv[3] ?? 40);
const RUN = Math.random().toString(36).slice(2, 7);
const home = process.env.PROFILE_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const p = await provisionSpace({ home, space, reach: "ip", runner: realRunner(), log: () => {} });
lap("provisioned");
/** @type {Map<string, { n: number, ms: number }>} */ const stat = new Map();
class Timed extends TwentyClient {
  async gql(path, query, vars) {
    const name = (/(?:query|mutation)\s+(\w+)/.exec(query) || [])[1] || "?";
    const t = Date.now();
    try { return await super.gql(path, query, vars); } finally { const s = stat.get(`${path}:${name.replace(/_.*/, "")}`) || { n: 0, ms: 0 }; s.n++; s.ms += Date.now() - t; stat.set(`${path}:${name.replace(/_.*/, "")}`, s); }
  }
}
const store = createTwentyStore({ space, client: new Timed({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), space, dir: path.join(spaceDir(home, space), "state"), webhookSecret: fs.readFileSync(p.webhookSecretFile, "utf8").trim() });
const report = (title) => { console.log(`-- ${title}`); for (const [k, s] of [...stat].sort((a, b) => b[1].ms - a[1].ms).slice(0, 14)) console.log(`${String(s.n).padStart(5)} calls ${String(s.ms).padStart(8)} ms  ${(s.ms / s.n).toFixed(0).padStart(6)} ms each  ${k}`); stat.clear(); };
const t1 = Date.now();
await store.define({ add_types: [...CORE_TYPES] });
lap(`define of ${CORE_TYPES.length} core types: ${((Date.now() - t1) / 1000).toFixed(1)}s`); report("define");
const t2 = Date.now();
for (let i = 0; i < N; i++) await store.create("contact", mintUuid(), { name: `Person ${i}`, email: `p${i}.${RUN}@example.test`, phone: `+1555${Math.floor(1000000 + Math.random() * 8999999)}` });
const s = (Date.now() - t2) / 1000;
lap(`${N} sequential creates: ${s.toFixed(1)}s (${(N / s).toFixed(1)}/s)`); report("create");
const t3 = Date.now();
await Promise.all(Array.from({ length: N }, (_, i) => store.create("contact", mintUuid(), { name: `Par ${i}`, email: `q${i}.${RUN}@example.test` })));
lap(`${N} parallel creates: ${((Date.now() - t3) / 1000).toFixed(1)}s`); report("parallel create");
// the same creates through the kernel's gateway (what an import does): every call it adds on top of the store's
const k = await createKernel({ space: "spc_aaaaaaaaaaaa", owner: "per_owner", owner_uid: 501, key: Buffer.alloc(32, 4), presence: { check: async () => null }, store });
const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: "per_owner", path: "direct", session: "s1" });
stat.clear();
const t4 = Date.now(); const M = Math.min(N, 30);
for (let i = 0; i < M; i++) await k.gateway.records.create(owner, "contact", { name: `Gate ${i}`, email: `g${i}.${RUN}@example.test` });
lap(`${M} sequential creates through the gateway: ${((Date.now() - t4) / 1000).toFixed(1)}s`); report("gateway create");
console.log("HOME", home);
