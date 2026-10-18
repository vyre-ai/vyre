// How fast Records feels on a real Twenty, through the kernel's gateway (the path every screen and tool takes): p50 and p95 over N runs for a list of 50 rows, a get, a create, an update, a view switch
// (a sorted and filtered list), a search and a define of one new field; then the memory the Twenty containers use after they settle. Run on a machine with Docker (CI: .github/workflows/perf-twenty.yml):
//   node stores/twenty/live/perf-live.mjs [label]
// It starts from the saved database when there is one (findGolden), as a new Space does, and removes the Space at the end. Prints one JSON line per operation and a table.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { provisionSpace, names, spaceDir, realRunner } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { TwentyClient } from "../client.js";
import { defineCore } from "../space-store.js";
import { createKernel } from "../../../kernel/index.js";

const label = process.argv[2] ?? "perf";
const N = Number(process.env.N || 20);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const n = names(label);
const q = (xs) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, p50: s[Math.floor(s.length * 0.5)], p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] }; };
const t0 = Date.now();
const p = await provisionSpace({ home, space: label, runner: realRunner(), reach: "ip", memory: process.env.PROFILE || "auto", log: () => {} });
console.log(`provisioned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const SPACE = "spc_" + "abcdefghijkl";
const store = createTwentyStore({ space: SPACE, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: path.join(spaceDir(home, label), "state"), webhookSecret: "x" });
await defineCore(store);
const OWNER = "per_" + "a".repeat(26);
const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 1), store, presence: { check: async () => "ok" } });
const chain = k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: OWNER, path: "direct" });
const R = k.gateway.records;
// 120 contacts so a page of 50 is a real page
const ids = [];
for (let i = 0; i < 120; i++) { const r = await R.create(chain, "contact", { name: `Person ${String(i).padStart(3, "0")}`, email: `p${i}@example.test` }); ids.push(r.id); }
const results = {};
const run = async (name, fn) => {
  await fn(-1);   // one warm-up call, not counted
  const xs = [];
  for (let i = 0; i < N; i++) { const t = performance.now(); await fn(i); xs.push(Math.round(performance.now() - t)); }
  results[name] = q(xs);
  console.log("OP", name, JSON.stringify(results[name]));
};
await run("records.list (50 rows)", () => R.query(chain, "contact", { page: { limit: 50 } }));
await run("records.get", (i) => R.get(chain, "contact", ids[(i + 1) % ids.length]));
await run("records.create", (i) => R.create(chain, "contact", { name: `New ${i}`, email: `n${i}@example.test` }));
const vers = new Map();
await run("records.update", async (i) => { const id = ids[(i + 1) % ids.length]; const cur = await R.get(chain, "contact", id); vers.set(id, cur.version); const t = performance.now(); await R.update(chain, "contact", id, { name: `Renamed ${i}` }, cur.version); });
await run("view switch (sorted, filtered list)", () => R.query(chain, "contact", { sort: [{ field: "name", dir: "desc" }], filter: { field: "name", op: "contains", value: "Person" }, page: { limit: 50 } }));
await run("search", () => R.search(chain, { text: "Person 05", page: { limit: 20 } }));
const contact = (await store.types()).find((t) => t.name === "contact");
let added = 0;
await run("records.define (one new field)", async (i) => { if (i < 0) return; added++; contact.fields = [...contact.fields, { name: `extra_${i}`, kind: "text", label: `Extra ${i}` }]; await R.define(chain, { change_types: [JSON.parse(JSON.stringify(contact))] }); });
// the update timing above includes a get; time the update alone too
const upd = [];
for (let i = 0; i < N; i++) { const id = ids[(i + 7) % ids.length]; const cur = await R.get(chain, "contact", id); const t = performance.now(); await R.update(chain, "contact", id, { name: `Again ${i}` }, cur.version); upd.push(Math.round(performance.now() - t)); }
results["records.update (alone)"] = q(upd); console.log("OP records.update (alone)", JSON.stringify(results["records.update (alone)"]));
await new Promise((r) => setTimeout(r, 20000));
const mem = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}} {{.MemUsage}} {{.CPUPerc}}"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(n.project)).join("\n");
console.log("MEMORY after settle (name, memory, cpu):\n" + mem);
const budget = { "records.list (50 rows)": 300, "records.get": 200, "records.create": 200, "records.update (alone)": 200, "records.define (one new field)": 2000 };
console.log("\nOPERATION | p50 ms | p95 ms | budget");
for (const [k2, v] of Object.entries(results)) console.log(`${k2} | ${v.p50} | ${v.p95} | ${budget[k2] ?? "-"}${budget[k2] && v.p95 > budget[k2] ? "  OVER" : ""}`);
execFileSync("docker", ["compose", "-p", n.project, "down", "-v"], { stdio: "ignore", timeout: 120000 });
fs.rmSync(home, { recursive: true, force: true });
// run 14:36
