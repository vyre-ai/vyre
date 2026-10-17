// Per-module heap cost: import one file in a fresh process, force a GC, print the heap used above an empty process. Run for every module entry and a few data loaders.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const one = process.argv[2];
if (one) {
  const base = (() => { global.gc(); return process.memoryUsage().heapUsed; })();
  await import(path.resolve(one)).catch(() => {});
  global.gc(); global.gc();
  console.log(((process.memoryUsage().heapUsed - base) / 1048576).toFixed(2));
  process.exit(0);
}
const files = [];
for (const d of fs.readdirSync("core", { withFileTypes: true })) if (d.isDirectory() && fs.existsSync(`core/${d.name}/index.js`)) files.push(`core/${d.name}/index.js`);
for (const f of ["lib/mcp-catalog.js", "lib/connector-presets/index.js", "lib/connectors/index.js", "kernel/flows/index.js", "kernel/flows/schema.js"]) if (fs.existsSync(f)) files.push(f);
const rows = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ["--expose-gc", "--no-warnings", import.meta.filename, f], { encoding: "utf8", timeout: 60_000, env: { ...process.env, VYRE_HOME: fs.mkdtempSync("/tmp/hp-") } });
  const n = Number((r.stdout || "").trim().split("\n").pop());
  if (Number.isFinite(n)) rows.push([n, f]);
}
rows.sort((a, b) => b[0] - a[0]);
for (const [n, f] of rows) console.log(`${n.toFixed(2).padStart(7)} MB  ${f}`);
