// Measure one Space's Twenty under a memory profile on a real box. Run on a test box:
//   node stores/twenty/live/measure-live.mjs <space> [tiny|small|auto]
// Provisions the Space with the profile, defines the core types and the estate planning kit, creates and reads a burst of records (the "automation run"), samples `docker stats` every
// two seconds throughout, prints each container's peak and the sum, then removes the Space (docker compose down -v).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { provisionSpace, names, spaceDir, realRunner, memoryOf, MEMORY_PROFILES } from "../provision.js";
import { createTwentyStore } from "../store.js";
import { mintUuid } from "../../../kernel/core/ids.js";
import { TwentyClient } from "../client.js";
import { compile } from "../../../records/language/compile.js";
import { CORE_TYPES } from "../../../records/core-types.js";

const space = process.argv[2] ?? "measure";
const profile = process.argv[3] ?? "tiny";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-home-"));
const n = names(space);
const t0 = Date.now();
const lap = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
const mb = (s) => { const m = /^([\d.]+)\s*([KMG]i?B)/i.exec(s.trim()); if (!m) return 0; const v = Number(m[1]); const u = m[2].toUpperCase(); return u.startsWith("G") ? v * 1024 : u.startsWith("K") ? v / 1024 : v; };
const peak = new Map();
const sample = () => {
  try {
    for (const line of execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}"], { timeout: 20000 }).toString().trim().split("\n")) {
      const [name, usage] = line.split("|");
      if (!name || !name.startsWith(n.project)) continue;
      const v = mb(String(usage).split("/")[0]);
      peak.set(name, Math.max(peak.get(name) ?? 0, v));
    }
  } catch { /* a sample may fail while containers restart */ }
};
const timer = setInterval(sample, 2000);
console.log("profile", profile, JSON.stringify(memoryOf(profile)), "host total MB", Math.round(os.totalmem() / 1048576));
const p = await provisionSpace({ home, space, reach: "ip", runner: realRunner(), memory: profile, log: lap });
lap(`provisioned at ${p.url}`);
const store = createTwentyStore({ space, client: new TwentyClient({ url: p.url, key: () => fs.readFileSync(p.keyFile, "utf8").trim() }), dir: path.join(spaceDir(home, space), "state"), webhookSecret: "x" });
const kit = compile(fs.readFileSync(new URL("../../../records/kits/estate-planning/kit.ts", import.meta.url), "utf8"));
await store.define({ add_types: [...CORE_TYPES] });
await store.define({ add_types: kit.types });
lap("types defined");
const ids = [];
for (let i = 0; i < 150; i++) { const c = await store.create("contact", mintUuid(), { name: `Person ${i}`, email: `p${i}@example.test` }); ids.push(c.id); if (i % 25 === 0) sample(); }
lap("150 contacts created");
for (let r = 0; r < 3; r++) { for (const id of ids.slice(0, 100)) await store.get("contact", id); await store.query("contact", { page: { limit: 100 } }); }
lap("reads done");
sample();
await new Promise((r) => setTimeout(r, 6000));
sample();
clearInterval(timer);
const sum = [...peak.values()].reduce((a, b) => a + b, 0);
for (const [name, v] of peak) console.log(`PEAK ${name.replace(n.project + "-", "")} ${v.toFixed(0)} MB`);
console.log(`PEAK SUM ${sum.toFixed(0)} MB`);
console.log(execFileSync("free", ["-m"]).toString().trim());
execFileSync("docker", ["compose", "-p", n.project, "down", "-v"], { stdio: "ignore", timeout: 120000 });
lap("removed");
