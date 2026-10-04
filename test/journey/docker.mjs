// @ts-check
// A fake `docker` on the "server" PATH, emulating only what install-box.sh and box/vyre use.
// The stack's one real piece is vyred: `compose up` starts `node core/daemon/main.js` with the
// container's environment (rig.json `container`), `compose exec vyre <cmd>` runs <cmd> with that
// environment (`vyre` being this checkout's bin/vyre), and `compose stop` or `down` stops it.
// Everything else is recorded and succeeds. Every call is logged to docker.log.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const rig = JSON.parse(fs.readFileSync(String(process.env.JOURNEY_RIG), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(rig.log.docker, args.join(" ") + "\n");
const home = rig.container.env.VYRE_HOME;
const pidFile = path.join(home, "vyred.pid");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function running() {
  try { const pid = Number(fs.readFileSync(pidFile, "utf8")); process.kill(pid, 0); return pid; } catch { return 0; }
}

async function startVyred() {
  if (running()) return;
  fs.mkdirSync(home, { recursive: true });
  const fd = fs.openSync(path.join(rig.root, "srv", "vyred.out"), "a");
  const child = spawn(process.execPath, [path.join(rig.repo, "core", "daemon", "main.js")], { detached: true, stdio: ["ignore", fd, fd], env: rig.container.env });
  child.unref();
  // Like `up -d --wait`: back once the container is up, here once vyred wrote its pid.
  for (let n = 0; n < 150 && !running(); n++) await sleep(100);
}

async function stopVyred() {
  const pid = running();
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  for (let n = 0; n < 100; n++) { try { process.kill(pid, 0); } catch { return; } await sleep(50); }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function main() {
  const [cmd, sub, ...rest] = args;
  if (cmd === "info") return 0;
  // install-box.sh's end check: `docker ps -q --filter name=vyre-vyre-1 --filter status=running` lists the container once vyred is up.
  if (cmd === "ps") { if (running()) process.stdout.write("vyre-container\n"); return 0; }
  if (cmd !== "compose") return 0; // run, volume, manifest inspect, ...: recorded only
  if (sub === "version") { process.stdout.write(rest.includes("--short") ? "2.29.0\n" : "Docker Compose version v2.29.0\n"); return 0; }
  if (sub === "up") {
    const service = rest.filter(a => !a.startsWith("-")).pop();
    if (!service || service === "vyre") await startVyred();
    return 0;
  }
  if (sub === "start") { await startVyred(); return 0; }
  if (sub === "stop" || sub === "down") { await stopVyred(); return 0; }
  if (sub === "exec") {
    const env = { ...rig.container.env };
    let i = 0;
    for (; i < rest.length; i++) {
      const a = rest[i];
      if (a === "-T" || a === "-i" || a === "-it") continue;
      if (a === "-e" || a === "--env") { const [k, ...v] = rest[++i].split("="); env[k] = v.join("="); continue; }
      break;
    }
    if (rest[i] !== "vyre") { process.stderr.write(`no such service: ${rest[i]}\n`); return 1; }
    if (!running()) { process.stderr.write("service \"vyre\" is not running\n"); return 1; }
    let argv = rest.slice(i + 1);
    if (argv[0] === "vyre") argv = [process.execPath, path.join(rig.repo, "bin", "vyre"), ...argv.slice(1)];
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env, cwd: env.HOME });
    return new Promise(res => child.on("exit", code => res(code ?? 1)));
  }
  return 0; // ps, pull, build, logs
}

process.exit(await main());
