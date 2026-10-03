#!/usr/bin/env node
// Which encrypted image format is fastest for small-file work on macOS? Same workload (core/runner/testing/perf-worker.mjs) in a plain
// folder and in each format, all AES-256. Hosted macOS runner only (VYRE_TEST_HOSTED=1).
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn, spawnSync } from "node:child_process";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsb-"));
const worker = new URL("../core/runner/testing/perf-worker.mjs", import.meta.url).pathname;
const run = (dir, scen) => new Promise(res => { const c = spawn(process.execPath, [worker], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] }); let b = "", got = null; c.stdout.on("data", d => { b += d; for (const l of b.split("\n")) { try { const j = JSON.parse(l); if (j.scenario) got = j; if (j.type === "result") { c.kill(); res(got); return; } } catch {} } }); c.on("spawn", () => c.stdin.write("run " + scen + "\n")); });
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pass = Buffer.from("0123456789abcdef0123456789abcdef");
function mk(name, args) {
  const img = path.join(root, name); const mnt = path.join(root, name + ".mnt"); fs.mkdirSync(mnt);
  let r = spawnSync("/usr/bin/hdiutil", ["create", ...args, "-encryption", "AES-256", "-stdinpass", "-quiet", img], { input: pass });
  if (r.status !== 0) return { name, error: String(r.stderr).slice(0, 120) };
  const file = fs.readdirSync(root).find(f => f.startsWith(name + ".") && !f.endsWith(".mnt"));
  r = spawnSync("/usr/bin/hdiutil", ["attach", "-stdinpass", "-nobrowse", "-noverify", "-mountpoint", mnt, "-quiet", path.join(root, file)], { input: pass });
  if (r.status !== 0) return { name, error: "attach " + String(r.stderr).slice(0, 120) };
  return { name, dir: mnt };
}
const targets = [{ name: "plain", dir: (() => { const d = path.join(root, "plain"); fs.mkdirSync(d); return d; })() },
  mk("sparse-apfs", ["-size", "4g", "-type", "SPARSE", "-fs", "APFS", "-volname", "v"]),
  mk("sparse-hfs", ["-size", "4g", "-type", "SPARSE", "-fs", "HFS+J", "-volname", "v"]),
  mk("bundle-apfs", ["-size", "4g", "-type", "SPARSEBUNDLE", "-fs", "APFS", "-volname", "v"]),
  mk("bundle-hfs", ["-size", "4g", "-type", "SPARSEBUNDLE", "-fs", "HFS+J", "-volname", "v"]),
  mk("bundle-hfs-band64m", ["-size", "4g", "-type", "SPARSEBUNDLE", "-fs", "HFS+J", "-volname", "v", "-imagekey", "sparse-band-size=131072"])];
const out = [];
for (const t of targets) {
  if (t.error) { out.push({ name: t.name, error: t.error }); continue; }
  const row = { name: t.name };
  for (const scen of ["writes", "search", "extract"]) { const x = []; for (let i = 0; i < 3; i++) x.push((await run(t.dir, scen)).ms); row[scen] = Math.round(med(x)); }
  out.push(row);
}
const base = out.find(r => r.name === "plain");
for (const r of out) if (!r.error) for (const k of ["writes", "search", "extract"]) r[k + "_x"] = +(r[k] / base[k]).toFixed(2);
console.log(JSON.stringify(out, null, 1));
for (const t of targets) if (t.dir && t.name !== "plain") spawnSync("/usr/bin/hdiutil", ["detach", t.dir, "-force", "-quiet"]);
fs.rmSync(root, { recursive: true, force: true });
