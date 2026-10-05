// Per-record create latency against a real Twenty, in three layers, so we can see whose time it is. Run on a test box:
//   node stores/twenty/live/latency-live.mjs <space-label> [profile]
// Provisions the Space, defines the core types, then times N creates (1) at the store (stores/twenty/store.js), with every HTTP request to Twenty timed and counted, and (2) through the kernel's
// gateway (records.create: authorize, validate, store, log). Prints per-create ms (median, p90), HTTP requests per create and the ms spent waiting on Twenty. Removes the Space.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { provisionSpace, names, spaceDir, realRunner } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { mintUuid } from "../../../kernel/core/ids.js";
import { TwentyClient } from "../client.js";
import { CORE_TYPES } from "../../../records/core-types.js";
import { createKernel } from "../../../kernel/index.js";

const label = process.argv[2] ?? "lat";
const profile = process.argv[3] ?? "standard";
const N = Number(process.env.N || 30);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const n = names(label);
const stat = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) }; };
const p = await provisionSpace({ home, space: label, runner: realRunner(), reach: "ip", memory: profile, log: () => {} });
const SPACE = "spc_" + "abcdefghijkl";
let http = [];
const timedFetch = async (url, init) => { const t = Date.now(); try { return await fetch(url, init); } finally { http.push({ ms: Date.now() - t, op: String(init && init.body || "").match(/(query|mutation)\s+(\w+)/)?.[0] ?? "?" }); } };
const client = new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim(), fetch: timedFetch });
const store = createTwentyStore({ space: SPACE, client, dir: path.join(spaceDir(home, label), "state"), webhookSecret: "x" });
await store.define({ add_types: [...CORE_TYPES] });
const layer = async (name, make) => {
  const per = [], reqs = [], waits = [];
  for (let i = 0; i < N; i++) { http = []; const t = Date.now(); await make(i); per.push(Date.now() - t); reqs.push(http.length); waits.push(http.reduce((a, b) => a + b.ms, 0)); }
  console.log(`LAYER ${name}`, JSON.stringify({ per_create_ms: stat(per), http_requests_per_create: stat(reqs), ms_waiting_on_twenty: stat(waits) }));
  const ops = new Map(); for (const h of http) ops.set(h.op, (ops.get(h.op) ?? 0) + 1); console.log(`LAST CREATE REQUESTS`, JSON.stringify([...ops]), JSON.stringify(http.map((h) => h.ms)));
};
await layer("store.create", async (i) => { await store.create("contact", mintUuid(), { name: `Store ${i}`, email: `s${i}@example.test` }); });
const key = Buffer.alloc(32, 1);
const OWNER = "per_" + "a".repeat(26);
const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key, store, presence: { check: async () => "ok" } });
const chain = k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: OWNER, path: "direct" });
await layer("gateway records.create", async (i) => { await k.gateway.records.create(chain, "contact", { name: `Gw ${i}`, email: `g${i}@example.test` }); });
console.log("HOST", os.totalmem() / 1048576 | 0, "MB total, load", os.loadavg().map((x) => x.toFixed(2)).join(" "));
execFileSync("docker", ["compose", "-p", n.project, "down", "-v"], { stdio: "ignore", timeout: 120000 });
console.log("removed");
