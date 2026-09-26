// @ts-check
// A fake `ssh` for the journey harness (VYRE_SSH_BIN). The "server" is a folder on this machine,
// so a remote command runs here under `sh -c` with the server's environment (rig.json `server`),
// never this Mac's. Control operations (-O check, exit, forward, cancel) succeed. A forward is
// real: the server's onboarding page listens on [::1] (its "host loopback"), and -O forward
// starts a relay from this Mac's 127.0.0.1 to it, so the port check and the browser behave as
// they would across two machines. Every call is logged, one line of argv, to ssh.log.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const rig = JSON.parse(fs.readFileSync(String(process.env.JOURNEY_RIG), "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(rig.log.ssh, args.join(" ") + "\n");

let op = "", spec = "", tty = false, i = 0;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === "-o") { i++; continue; }
  if (a === "-O") { op = args[++i]; continue; }
  if (a === "-L") { spec = args[++i]; continue; }
  if (a === "-t") { tty = true; continue; }
  if (a.startsWith("-")) continue;
  break;
}
const command = args.slice(i + 1).join(" ");
const pidFile = port => path.join(rig.forwards, `${port}.pid`);

function kill(file) {
  try { process.kill(Number(fs.readFileSync(file, "utf8")), "SIGTERM"); } catch {}
  fs.rmSync(file, { force: true });
}

if (op === "forward") {
  const [local, , remote] = spec.split(":");
  const ready = path.join(rig.forwards, `${local}.ready`);
  fs.rmSync(ready, { force: true });
  const child = spawn(process.execPath, [path.join(rig.here, "forward.mjs"), local, remote, ready], { detached: true, stdio: "ignore" });
  child.unref();
  for (let n = 0; n < 100; n++) {
    await new Promise(r => setTimeout(r, 30));
    if (fs.existsSync(ready)) {
      const said = fs.readFileSync(ready, "utf8");
      if (said === "ok") { fs.writeFileSync(pidFile(local), String(child.pid)); process.exit(0); }
      process.stderr.write(`bind [127.0.0.1]:${local}: ${said}\n`);
      process.exit(255);
    }
  }
  process.stderr.write("forward did not start\n");
  process.exit(255);
}
if (op === "cancel") { kill(pidFile(spec.split(":")[0])); process.exit(0); }
if (op === "exit") { for (const f of fs.readdirSync(rig.forwards)) if (f.endsWith(".pid")) kill(path.join(rig.forwards, f)); process.exit(0); }
if (op) process.exit(0);

// A remote command: the server's shell, in the server's home, with sshd's SSH_CONNECTION.
void tty;
const child = spawn("/bin/sh", ["-c", command || "true"], { stdio: "inherit", cwd: rig.server.env.HOME, env: rig.server.env });
child.on("exit", code => process.exit(code ?? 1));
