// J6 (agent half): Vyre Computer against a fake GoHighLevel page, on a CI runner. It reuses the standalone
// harness (local/hands-chrome-mac/standalone/harness/real.mjs: the built package, the real extension and native
// host in a temp Chrome profile, an MCP client over stdio, and the bench's GoHighLevel-shaped fixture) and folds
// its stages into the matrix's results by journey step. Then step 6.7: install and uninstall in a temp home and
// list what is left. No server or vault is involved here: those parts are marked, never faked.
//
//   node scripts/matrix/j6.mjs <out-dir>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { recorder } from "./lib/results.mjs";
import { build } from "../../local/hands-chrome-mac/standalone/build-release.mjs";

if (!process.env.CI) { console.error("j6: runs on a CI runner only (CI is unset)"); process.exit(2); }
const out = path.resolve(process.argv[2] || "results");
fs.mkdirSync(out, { recursive: true });
const r = recorder(out, "J6", `${process.platform}-chrome`);

const t0 = Date.now();
const real = spawnSync(process.execPath, ["local/hands-chrome-mac/standalone/harness/real.mjs", "--iters", "10", "--out", path.join(out, "j6-real.json")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 9 * 60_000 });
fs.writeFileSync(path.join(out, "j6-real.log"), (real.stdout || "") + (real.stderr || ""));
let res = { stages: {}, fatal: "no results file" };
try { res = JSON.parse(fs.readFileSync(path.join(out, "j6-real.json"), "utf8")); } catch { /* fatal stays */ }
const st = res.stages || {};
const fold = (step, names, why) => {
  const seen = names.filter(n => st[n]);
  if (!seen.length) { r.step(step, "skip", { why: res.fatal ? `the harness stopped early: ${String(res.fatal).slice(0, 200)}` : "no such stage ran" }); return; }
  const bad = seen.filter(n => st[n].ok === false);
  const missing = names.filter(n => !st[n]);
  r.step(step, bad.length === 0 && missing.length === 0, { why: bad.length ? `${bad[0]}: ${String(st[bad[0]].error).slice(0, 220)}` : missing.length ? `did not run: ${missing.join(", ")}` : `${why} (${seen.map(n => `${n} ${st[n].ms} ms`).join(", ")})` });
};

fold("6.1-extension-loads-and-connects", ["mcp_initialize", "connected"], "the real extension in a temp profile connected to the standalone connector");
fold("6.2-click-type-read-on-fake-ghl", ["tabs_use", "snapshot", "fill_12", "click", "batch_20_one_call", "ghl_robust_flow"], "click, type and read through MCP on a page with GoHighLevel's awkward moments (slow route, popup, unsaved guard, toast, stale re-render)");
r.step("6.3-vault-fill-and-save", "skip", { why: "needs the box's vault; the standalone connector has none. The vault extension's own unit tests cover the form logic, a real fill is rehearsal 6.6c (by hand)" });
fold("6.3b-login-handoff", ["login_handoff"], "a login page is handed to the person, never filled by the agent");
fold("6.4-sends-and-writes-held", ["held_send", "writes_held_everywhere", "eval_form_submit_refused", "plan_approval", "presence"], "an outward send and every write are held for the person, a script cannot submit a form");
fold("6.4b-blind-and-egress-refusals", ["blind_refused", "egress_blocked", "esc_halts_batch"], "a page the agent cannot see, a blocked host, and Esc halting a running batch");
fold("6.4c-trace-holds-no-secret", ["trace_and_report"], "the trace exists and masks the values");
for (const s of ["6.5-vyretest-sign-in", "6.6-list-and-create-contact", "6.6b-vault-pairing", "6.6c-real-login-fill"]) r.step(s, "by-hand", { why: "needs the person's own Chrome in vyretest and a GHL test sub-account (rehearsal U3)" });

// 6.7 remove the extension: install and uninstall in a temp home, then list what is left behind.
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "j6u-"));
  const home = path.join(tmp, "home"), data = path.join(tmp, "data");
  fs.mkdirSync(home);
  const rel = build({ out: path.join(tmp, "release") });
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), VYRE_CHROME_HOME: data, VYRE_CHROME_TEST: "1" };
  const cliIn = path.join(rel.dir, "standalone", "cli.mjs");
  const inst = spawnSync(process.execPath, [cliIn, "install", "--browsers", "chrome"], { env, encoding: "utf8" });
  const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
  // On Windows the host is registered in the registry (HKCU), not as a file in the home folder.
  const regHosts = () => {
    const q = spawnSync("reg", ["query", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts"], { encoding: "utf8" });
    return String(q.stdout || "").split(/\r?\n/).filter(l => /vyre/i.test(l)).map(l => l.trim());
  };
  const hosts = () => process.platform === "win32" ? regHosts() : walk(home).filter(f => /NativeMessagingHosts/.test(f));
  const had = hosts();
  const un = spawnSync(process.execPath, [path.join(data, "app", "standalone", "cli.mjs"), "uninstall"], { env, encoding: "utf8" });
  const left = hosts();
  r.step("6.7-uninstall-leaves-no-native-host", inst.status === 0 && un.status === 0 && had.length > 0 && left.length === 0, { why: inst.status !== 0 ? `install exit ${inst.status}` : un.status !== 0 ? `uninstall exit ${un.status}` : had.length === 0 ? "install registered no native host file here (platform keeps it elsewhere, e.g. the Windows registry)" : left.length ? `left: ${left.map(f => path.isAbsolute(f) ? path.relative(home, f) : f).join(", ")}` : `${had.length} host file(s) were registered and none is left` });
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) { r.step("6.7-uninstall-leaves-no-native-host", false, { why: String(e.message).slice(0, 220) }); }

r.step("6.run", real.status === 0, { ms: Date.now() - t0, why: real.status === 0 ? undefined : `harness exit ${real.status}` });
process.exit(r.failed ? 1 : 0);
