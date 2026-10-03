// kernel/store/bench/load-bounded.mjs: records' load script (stores/twenty/live/load-live.mjs on work/records) on the built-in SQLite store, with the script's own id lists capped
// to a sample so the process's memory is the kernel's. Run by hand from a tree that also has records/ and stores/ from work/records:
//   node --expose-gc kernel/store/bench/load-bounded.mjs sqlite 20000,100000,500000 30 20
// One Space under about 20 people's worth of record work, through the kernel gateway, on either store.
//   node stores/twenty/live/load-live.mjs <sqlite|twenty> [sizes, default 5000,20000] [seconds per size, default 60] [users, default 20]
// Seeds contacts and matters (the Estate planning types) up to each size, then runs `users` simulated people for the given seconds: each loops reading
// a record, listing matters by stage sorted by fee, finding a contact by email, searching, editing (read, then update at the version read) and now and then
// adding a record, with 200 to 500 ms between actions. Prints per-action p50 and p95, throughput, errors, memory and the box's load. Twenty is provisioned
// in a temp home with the `small` profile and torn down at the end.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { bootKernel } from "../../boot.js";
import { compile } from "../../../records/language/compile.js";

const kind = "sqlite"; const [, sizesArg = "5000,20000", secArg = "60", usersArg = "20"] = process.argv.slice(2);
const sizes = sizesArg.split(",").map(Number), SECONDS = Number(secArg), USERS = Number(usersArg);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-load-"));
const t0 = Date.now(); const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`);
const load = () => os.loadavg().map((x) => x.toFixed(1)).join(" ");
const kit = compile(fs.readFileSync(new URL("../../../records/kits/estate-planning/kit.ts", import.meta.url), "utf8"));
const SPACE = "spc_loadtest0001", OWNER = "per_owner", space = "loadtest";

let store; const stats = () => "";
const k = await bootKernel({ db: (() => { const d = new DatabaseSync(path.join(home, "kernel.db")); if (process.env.BENCH_WAL !== "0") d.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL"); return d; })(), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), ...(store ? { store } : {}) });
const chain = () => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
const R = k.gateway.records;
await R.define(chain(), { add_types: kit.types });
lap(`${kind} ready; kernel on ${store ? "Twenty" : "SQLite"}; load ${load()}`);

const stages = ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"];
const rnd = (n) => Math.floor(Math.random() * n);
const snap = () => { global.gc?.(); const st = k.store.stats ? k.store.stats() : {}; return `rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB, log ${k.log.stats ? k.log.stats().in_memory : k.log.latestSeq()} of ${k.log.latestSeq()} events in memory, hot rows ${st.hot_rows ?? "-"}`; };
const contacts = [], matters = [];
let nContacts = 0, nMatters = 0;
// the script keeps a SAMPLE of ids (20,000 at most), so its own memory stays flat and RSS shows the kernel's
const CAP = 20000;
const keep = (arr, id, n) => { if (arr.length < CAP) arr.push(id); else arr[Math.floor(Math.random() * n)] = id; };
let seq = 0;
async function addContact() { const i = ++seq; const c = await R.create(chain(), "contact", { full_name: `Client ${i} Rivera`, email: `client${i}@example.test`, phone: `555${String(i).padStart(7, "0")}`, stripe_customer: `cus_${i}` }); keep(contacts, c.id, ++nContacts); return c; }
async function addMatter() { const c = contacts[rnd(contacts.length)]; const i = ++seq; const m = await R.create(chain(), "matter", { title: `Estate plan ${i}`, client: { urn: `vyre://${SPACE}/contact/${c}` }, plan: ["Will", "Trust", "Both"][rnd(3)], fee: { amount: 1500 + rnd(8000), currency: "USD" }, stage: stages[rnd(6)], engagement_signed: true, stripe_payment: `pi_${i}` }); keep(matters, m.id, ++nMatters); return m; }
async function seedTo(n) {
  const t = Date.now(), start = nContacts + nMatters;
  const want = Math.floor(n * 1), cc = Math.ceil(want * 0.6);
  while (nContacts < cc) await Promise.all(Array.from({ length: Math.min(16, cc - nContacts) }, addContact));
  while (nContacts + nMatters < want) await Promise.all(Array.from({ length: Math.min(16, want - nContacts - nMatters) }, addMatter));
  lap(`seeded to ${nContacts + nMatters} records (${((nContacts + nMatters - start) / ((Date.now() - t) / 1000)).toFixed(0)} writes/s); ${snap()}`);
}

const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
async function run(label) {
  /** @type {Record<string, number[]>} */ const lat = {}; /** @type {Record<string, number>} */ const err = {};
  const timed = async (name, fn) => { const s = performance.now(); try { await fn(); } catch (e) { const c = e.code || "error"; err[`${name}:${c}`] = (err[`${name}:${c}`] ?? 0) + 1; return; } (lat[name] ??= []).push(performance.now() - s); };
  const until = Date.now() + SECONDS * 1000;
  const user = async () => {
    while (Date.now() < until) {
      const r = Math.random();
      if (r < 0.25) await timed("get", () => R.get(chain(), "matter", matters[rnd(matters.length)]));
      else if (r < 0.45) await timed("list by stage, sorted", () => R.query(chain(), "matter", { filter: { field: "stage", op: "eq", value: stages[rnd(6)] }, sort: [{ field: "fee", dir: "desc" }], page: { limit: 25 } }));
      else if (r < 0.60) await timed("find by email", () => R.query(chain(), "contact", { filter: { field: "email", op: "eq", value: `client${1 + rnd(seq)}@example.test` }, page: { limit: 5 } }));
      else if (r < 0.70) await timed("search", () => R.search(chain(), { text: `Client ${1 + rnd(seq)}`, types: ["contact"], page: { limit: 10 } }));
      else if (r < 0.92) await timed("edit (read + update)", async () => { const m = await R.get(chain(), "matter", matters[rnd(matters.length)]); await R.update(chain(), "matter", m.id, { practice_area: ["Estate", "Trust", "Probate"][rnd(3)], household_size: 1 + rnd(6) }, m.version); });
      else if (r < 0.98) await timed("add contact", addContact);
      else await timed("count by stage", () => R.aggregate(chain(), "matter", { group_by: ["stage"], measures: [{ fn: "count" }] }));
      await new Promise((res) => setTimeout(res, 200 + rnd(300)));
    }
  };
  const t = Date.now(), before = process.memoryUsage().rss;
  await Promise.all(Array.from({ length: USERS }, user));
  const secs = (Date.now() - t) / 1000, total = Object.values(lat).reduce((a, b) => a + b.length, 0);
  console.log(`\n== ${kind}, ${nContacts + nMatters} records, ${USERS} people for ${secs.toFixed(0)}s: ${total} actions, ${(total / secs).toFixed(1)}/s, box load (1/5/15 min) ${load()} ==`);
  for (const [n, a] of Object.entries(lat)) console.log(`  ${n.padEnd(24)} n=${String(a.length).padStart(5)}  p50 ${pct(a, 0.5).toFixed(0).padStart(5)} ms  p95 ${pct(a, 0.95).toFixed(0).padStart(5)} ms  p99 ${pct(a, 0.99).toFixed(0).padStart(5)} ms`);
  console.log(`  errors: ${JSON.stringify(err)}`);
  console.log(`  gateway process rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB (was ${(before / 1048576).toFixed(0)}); sqlite file ${(fs.statSync(path.join(home, "kernel.db")).size / 1048576).toFixed(1)} MB`);
  if (kind === "twenty") console.log("  Twenty containers:\n    " + stats());
}
try {
  for (const n of sizes) { await seedTo(n); await run(`${n}`); }
  console.log("\nlog verify:", JSON.stringify(await k.gateway.audit.verify()));
} finally {
  if (kind === "twenty") { try { execFileSync("docker", ["compose", "-p", names(space).project, "down", "-v"], { cwd: spaceDir(home, space), stdio: "ignore" }); } catch {} }
  fs.rmSync(home, { recursive: true, force: true });
}
