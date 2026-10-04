#!/usr/bin/env node
// Runs the real claude binary inside the home sandbox on a hosted macOS runner: does it start under the write-deny profile? (reviewer-2 ES-3, the lead's ES-1.)
// Prints what it did and any write it was refused, so the redirects the profile needs can be listed. Hosted runner only (VYRE_TEST_HOSTED=1).
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import net from "node:net"; import { execFileSync } from "node:child_process";
import { planHome, selfTest } from "../core/runner/homesandbox.js";
import { launch } from "../core/runner/sandbox.js";
const claude = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cl-")); const run = path.join(home, ".vyre/run"); fs.mkdirSync(run, { recursive: true });
for (const d of ["proj", "t", ".realcfg", ".vyre/keys"]) fs.mkdirSync(path.join(home, d), { recursive: true }); fs.writeFileSync(path.join(home, ".vyre/keys/k"), "K");
const servers = []; const lis = async n => { const s = net.createServer(c => c.end()); await new Promise(r => s.listen(path.join(run, n + ".sock"), r)); servers.push(s); };
for (const n of ["own", "other", "person"]) await lis(n);
const dsv = net.createServer(c => c.end()); await new Promise(r => dsv.listen(0, "127.0.0.1", r));
const agent = { command: claude, versionArgs: ["--version"], hosts: ["api.anthropic.com:443"], private: { from: path.join(home, ".realcfg"), env: "CLAUDE_CONFIG_DIR", credentialFiles: [".credentials.json"] } };
const base = { platform: "darwin", command: claude, home, vyreHome: path.join(home, ".vyre"), sessionSocket: path.join(run, "own.sock"), workdirs: [path.join(home, "proj")], temp: path.join(home, "t"), readOnly: [path.dirname(fs.realpathSync(claude)), path.dirname(claude), path.dirname(process.execPath)], agent,
  probes: { personSocket: path.join(run, "person.sock"), otherSocket: path.join(run, "other.sock"), daemonPorts: [dsv.address().port], keyFile: path.join(home, ".vyre/keys/k") } };
const t0 = Date.now(); const st = await selfTest(base);
console.log(JSON.stringify({ claude, selfTestOk: st.ok, failures: st.failures, ms: Date.now() - t0 }, null, 1));
// the agent itself, a few commands that write caches or temp files, with what was refused
const p = planHome({ ...base, command: claude, args: ["--version"] });
const c = launch(p, { cwd: p.cwd }); let out = "", err = ""; c.stdout.on("data", d => out += d); c.stderr.on("data", d => err += d);
const code = await new Promise(r => { const k = setTimeout(() => { c.kill("SIGKILL"); r("timeout"); }, 60000); c.on("close", x => { clearTimeout(k); r(x); }); });
console.log(JSON.stringify({ claudeVersion: { code, out: out.trim().slice(0, 200), err: err.trim().slice(0, 400) } }, null, 1));
process.exit(0);
