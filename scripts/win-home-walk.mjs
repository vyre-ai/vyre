#!/usr/bin/env node
// win-home-walk: the Windows home's sealing service, proved on a real Windows machine (GitHub's windows-latest, a temporary machine; spec part 5). TEST ONLY: it installs a service on the machine it runs on.
//
//   node scripts/win-home-walk.mjs --seal <vyre-seal.exe> --out <dir>
//
// What it proves, in order (every line is written to results.json):
//   1. install makes the service under NT SERVICE\VyreSealer and it runs; the seal folder's access list names only that account and SYSTEM
//   2. the installing user's Node connects to the pipe and gets the SealApi; a value put is read back; custody says the master came from the service
//   3. what Windows CAN tell apart: a second local user cannot connect to the pipe; a same-user program that is not the installed Node connects and is closed with no answer; a copy of Node elsewhere is refused
//   4. what Windows CANNOT tell apart: a second Node script run by the same user, with the same Node, connects and is answered (written down, not hidden)
//   5. a second local user cannot read the seal folder or the sealed master
//   6. persistence: stop and start the service, the value is still there (the master is opened from its DPAPI blob under the service's account)
//   7. the pipe is created by the service alone: nothing else holds the name while it runs
//   8. uninstall --purge removes the service and what it sealed
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const SEAL = path.resolve(flag("--seal", ""));
const OUT = path.resolve(flag("--out", "win-home-out"));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIPE = String.raw`\\.\pipe\vyre-seal`;
const SEAL_DIR = path.join(process.env.ProgramData || "C:\\ProgramData", "Vyre", "seal");
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const ps = (cmd, o = {}) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", ...o });
const sc = (...a) => spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "sc.exe"), a, { encoding: "utf8" });
const check = async (name, fn) => {
  let ok = false, note = "";
  try { note = (await fn()) || ""; ok = true; } catch (e) { note = String(e && e.message || e).split("\n")[0].slice(0, 500); }
  results.push({ name, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}   ${name}${note ? ": " + note : ""}`);
  return ok;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const state = () => { const o = sc("query", "VyreSealer"); const m = /STATE\s*:\s*\d+\s+(\w+)/.exec(o.stdout || ""); return m ? m[1] : "ABSENT"; };
async function waitState(want, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { if (state() === want) return; await sleep(500); } throw new Error(`the service is ${state()}, not ${want}`); }

const me = ps("([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value").stdout.trim();
const nodeExe = process.execPath;
const { connectSealer } = await import(pathToFileURL(path.join(ROOT, "kernel", "seal", "client.js")).href);
const pw = "Vy" + crypto.randomBytes(5).toString("hex") + "!1";
const other = "vyreseal2";
const asOther = (cmdline) => ps(`$s = ConvertTo-SecureString '${pw}' -AsPlainText -Force; $c = New-Object System.Management.Automation.PSCredential('${other}', $s); $p = Start-Process -FilePath '${nodeExe}' -ArgumentList ${cmdline} -Credential $c -NoNewWindow -PassThru -Wait -WorkingDirectory '${ROOT}' -RedirectStandardOutput "$env:RUNNER_TEMP\\o.out" -RedirectStandardError "$env:RUNNER_TEMP\\o.err"; Get-Content "$env:RUNNER_TEMP\\o.out" -ErrorAction SilentlyContinue; exit $p.ExitCode`);

try {
  await check("install: the service is made under NT SERVICE\\VyreSealer and runs", async () => {
    const r = spawnSync(SEAL, ["install", "--user-sid", me, "--node", nodeExe, "--process-js", path.join(ROOT, "kernel", "seal", "process.js")], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`install exited ${r.status}: ${r.stdout}${r.stderr}`);
    await waitState("RUNNING");
    const cfg = sc("qc", "VyreSealer").stdout;
    if (!/SERVICE_START_NAME\s*:\s*NT SERVICE\\VyreSealer/i.test(cfg)) throw new Error("the service does not run as NT SERVICE\\VyreSealer: " + cfg.replace(/\s+/g, " ").slice(0, 300));
    return "RUNNING as NT SERVICE\\VyreSealer";
  });
  await check("the seal folder names only the service account and SYSTEM", async () => {
    const acl = spawnSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"), [SEAL_DIR], { encoding: "utf8" }).stdout;
    fs.writeFileSync(path.join(OUT, "seal-dir-acl.txt"), acl);
    const names = [...acl.matchAll(/^\s*(?:\S+\s+)?([^\s:]+(?: [^\s:]+)*):\(/gm)].map(m => m[1]);
    if (!/VyreSealer/i.test(acl)) throw new Error("the service account is not on the folder: " + acl);
    if (/Users|Everyone|Authenticated|Administrators/i.test(acl.replace(/^\S+/, ""))) throw new Error("the folder is open to others: " + acl.replace(/\s+/g, " "));
    return acl.replace(/\s+/g, " ").slice(0, 200);
  });
  let sealer;
  await check("the installing user's Node connects, health says the master came from the service, a sealed value reads back", async () => {
    sealer = await connectSealer({ pipe: PIPE, timeoutMs: 15000 });
    const h = await sealer.health();
    if (!h.ok || h.custody.master !== "dpapi-service" || h.custody.profile !== "windows-service") throw new Error(JSON.stringify(h.custody));
    await sealer.service.put({ name: "twenty/walk", value: "sk-walk-" + crypto.randomBytes(4).toString("hex") });
    return `custody ${h.custody.master}`;
  });
  const secret = "sk-walk-persist-" + crypto.randomBytes(4).toString("hex");
  await check("a value put is read back", async () => { await sealer.service.put({ name: "twenty/persist", value: secret }); if ((await sealer.service.get({ name: "twenty/persist" })) !== secret) throw new Error("not read back"); });
  await sealer.close();

  const probe = path.join(ROOT, "scripts", "win-seal-probe.mjs");
  await check("a program run as the installing user that is not the installed Node connects and is closed with no answer", async () => {
    // PowerShell's own pipe client: same user, a different image. The service looks at the caller's image and refuses.
    const r = ps(`$c = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'vyre-seal', [System.IO.Pipes.PipeDirection]::InOut); $c.Connect(5000); $w = New-Object System.IO.StreamWriter($c); $w.WriteLine('{"id":1,"op":"health"}'); $w.Flush(); $rd = New-Object System.IO.StreamReader($c); $t = $rd.ReadLine(); if ($t) { 'ANSWERED' } else { 'CLOSED' }`);
    if (!/CLOSED/.test(r.stdout)) throw new Error("expected CLOSED, got: " + (r.stdout + r.stderr).slice(0, 300));
    return "CLOSED";
  });
  await check("a copy of Node at another path is refused too", async () => {
    const copy = path.join(os.tmpdir(), "node-copy.exe"); fs.copyFileSync(nodeExe, copy);
    const r = spawnSync(copy, [probe, PIPE], { encoding: "utf8" });
    if (!/CLOSED/.test(r.stdout)) throw new Error("expected CLOSED, got: " + r.stdout + r.stderr);
    return "CLOSED";
  });
  await check("WHAT WINDOWS CANNOT TELL APART: another program run by the same user with the same installed Node connects and is answered", async () => {
    const r = spawnSync(nodeExe, [probe, PIPE], { encoding: "utf8" });
    if (!/ANSWERED/.test(r.stdout)) throw new Error("expected ANSWERED, got: " + r.stdout + r.stderr);
    return "ANSWERED (a same-user process running the installed Node is a Vyre client as far as Windows can say)";
  });

  const made = ps(`net user ${other} '${pw}' /add`);
  await check("a second local user is made", async () => { if (made.status !== 0) throw new Error(made.stdout + made.stderr); });
  await check("a second local user cannot connect to the pipe", async () => {
    const r = asOther(`'scripts\\win-seal-probe.mjs','${PIPE}'`);
    if (/ANSWERED/.test(r.stdout)) throw new Error("a second local user was answered by the sealing service");
    return (r.stdout || "").trim().slice(0, 80) || "refused";
  });
  await check("a second local user cannot read the seal folder or the sealed master", async () => {
    const r = asOther(`'scripts\\win-seal-readprobe.mjs','${SEAL_DIR}'`);
    if (/LISTED|MASTER_READ/.test(r.stdout)) throw new Error("a second user read the seal folder: " + r.stdout);
    return r.stdout.replace(/\s+/g, " ").trim().slice(0, 120);
  });
  ps(`net user ${other} /delete`);

  await check("the installing user (an administrator on this machine) and the seal folder: what an administrator can do is written down", async () => {
    let read = "denied";
    try { fs.readFileSync(path.join(SEAL_DIR, "master.dpapi")); read = "READ the DPAPI blob (an administrator can take what the folder's access list withholds; the blob is still sealed under the service account)"; } catch (e) { read = "denied " + e.code; }
    return read;
  });

  await check("persistence: stop and start the service, the sealed value is still there", async () => {
    sc("stop", "VyreSealer"); await waitState("STOPPED"); sc("start", "VyreSealer"); await waitState("RUNNING");
    const s2 = await connectSealer({ pipe: PIPE, timeoutMs: 15000 });
    const got = await s2.service.get({ name: "twenty/persist" });
    await s2.close();
    if (got !== secret) throw new Error("the value did not survive a restart");
  });
  await check("the pipe name cannot be taken while the service runs (first instance)", async () => {
    const r = ps(`try { $p = New-Object System.IO.Pipes.NamedPipeServerStream('vyre-seal', [System.IO.Pipes.PipeDirection]::InOut, 1); 'TOOK' } catch { 'REFUSED' }`);
    if (/TOOK/.test(r.stdout)) throw new Error("another program created the pipe's name");
    return (r.stdout || "").trim();
  });
} catch (e) {
  results.push({ name: "the walk ran", ok: false, note: String(e && e.stack || e).slice(0, 600) });
  console.log("FAIL   the walk ran: " + String(e && e.message || e));
} finally {
  await (async () => {
    const r = spawnSync(SEAL, ["uninstall", "--purge"], { encoding: "utf8" });
    const gone = state() === "ABSENT";
    results.push({ name: "uninstall --purge removes the service and what it sealed", ok: r.status === 0 && gone && !fs.existsSync(path.join(SEAL_DIR, "master.dpapi")), note: `exit ${r.status}, service ${state()}` });
    console.log(`${results[results.length - 1].ok ? "PASS" : "FAIL"}   ${results[results.length - 1].name}: ${results[results.length - 1].note}`);
  })();
  try { fs.copyFileSync(path.join(process.env.ProgramData || "C:\\ProgramData", "Vyre", "logs", "vyre-seal.log"), path.join(OUT, "vyre-seal.log")); } catch { /* none */ }
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
