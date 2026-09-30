// mac-bundle-measure.mjs: S2's numbers for a built Vyre.app, in CI only (docs/work/capsule-bundle.md).
//
//   node scripts/mac-bundle-measure.mjs <Vyre.app> [--idle 30]
//
// Starts the bundled node exactly as the LaunchAgent would (the plist's own ProgramArguments, the
// bundle's node, launchd's short PATH) but directly, never through launchctl, in a temp VYRE_HOME.
// Measures the time until vyred answers /v1/health on its socket (first start on an empty home,
// then again on the same home), RSS and CPU time after the idle wait, and runs the bundled CLI
// through a symlink against that node. Prints one JSON line and stops only the pid it started.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const app = path.resolve(process.argv[2] || "");
const idleAt = process.argv.indexOf("--idle");
const idle = idleAt > 0 ? Number(process.argv[idleAt + 1]) : 30;
const c = path.join(app, "Contents");
const plist = path.join(c, "Library/LaunchAgents/sh.vyre.node.plist");
if (!fs.existsSync(plist)) { console.error(`no LaunchAgent plist in ${app}`); process.exit(2); }

const agent = JSON.parse(spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }).stdout);
const program = path.join(app, agent.BundleProgram);
const args = agent.ProgramArguments.slice(1);
// Short, so the socket stays under macOS's 104-byte limit and in the home, as on a real Mac.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vb-"));
const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: os.homedir(), TMPDIR: os.tmpdir(),
  VYRE_HOME: home, VYRE_TAILSCALE_BIN: path.join(home, "no-tailscale"), VYRE_NO_DIALOGS: "1" };
const sock = path.join(fs.realpathSync(home), "vyred.sock");

/** @returns {Promise<any>} */
const health = () => new Promise(resolve => {
  const req = http.request({ socketPath: sock, path: "/v1/health", timeout: 1000 }, res => {
    let body = "";
    res.on("data", d => body += d);
    res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); } });
  });
  req.on("error", () => resolve(null));
  req.on("timeout", () => { req.destroy(); resolve(null); });
  req.end();
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(label) {
  const log = fs.openSync(path.join(home, `${label}.log`), "a");
  const t0 = performance.now();
  const child = spawn(program, args, { argv0: agent.ProgramArguments[0], env, stdio: ["ignore", log, log] });
  let exited = null;
  child.on("exit", code => { exited = code; });
  for (;;) {
    if (exited !== null) throw new Error(`the node exited ${exited} before answering: ${fs.readFileSync(path.join(home, `${label}.log`), "utf8").slice(-2000)}`);
    const h = await health();
    if (h) return { child, ms: Math.round(performance.now() - t0), health: h.data || h };
    if (performance.now() - t0 > 60_000) { child.kill("SIGTERM"); throw new Error("no answer on /v1/health within 60 s"); }
    await sleep(20);
  }
}
async function stop(child) {
  const done = new Promise(r => child.once("exit", r));
  child.kill("SIGTERM");
  await Promise.race([done, sleep(10_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
const ps = pid => {
  const [rss, time] = spawnSync("/bin/ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split(/\s+/);
  return { rss_mb: Math.round(Number(rss) / 1024 * 10) / 10, cpu_time: time };
};

const first = await start("first");
const atReady = ps(first.child.pid);
await sleep(idle * 1000);
const afterIdle = ps(first.child.pid);
// The CLI, reached through a symlink as a PATH entry would reach it.
const link = path.join(home, "vyre");
fs.symlinkSync(path.join(c, "Resources/bin/vyre"), link);
const cli = spawnSync(link, ["status"], { encoding: "utf8", env, timeout: 30_000 });
await stop(first.child);
const warm = await start("warm");
await stop(warm.child);

const du = p => Number(spawnSync("/usr/bin/du", ["-sk", p], { encoding: "utf8" }).stdout.split(/\s/)[0]);
const mb = kb => Math.round(kb / 1024 * 10) / 10;
console.log(JSON.stringify({
  node: first.health.node || spawnSync(program, ["--version"], { encoding: "utf8" }).stdout.trim(),
  version: first.health.version, role: first.health.role, machine: first.health.machine, supervisor: first.health.supervisor,
  cold_start_ms: { first: first.ms, warm: warm.ms },
  at_ready: atReady, [`after_${idle}s_idle`]: afterIdle,
  size_mb: { app: mb(du(app)), node: mb(du(path.join(c, "MacOS/node"))), capsule: mb(du(path.join(c, "MacOS/Vyre"))), package: mb(du(path.join(c, "Resources/vyre"))) },
  cli: { status: cli.status, out: (cli.stdout + cli.stderr).trim().split("\n").slice(0, 8) },
}));
fs.rmSync(home, { recursive: true, force: true });
