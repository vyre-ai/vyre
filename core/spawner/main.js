// @ts-check
// The box container's first process (ADR 0032 part 3). As root, with only SETUID, SETGID and
// KILL: it shares /work with the agent's group once, opens the spawner's socket for vyred, and
// runs vyred itself as uid `vyre`. Not root (an older compose file, a Mac): it runs
// vyred in this process, as before, and sessions spawn directly.

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve } from "./server.js";

const env = process.env;
const num = (v, d) => (/^\d+$/.test(String(v || "")) ? Number(v) : d);
const VYRE = num(env.VYRE_UID, 1000);
const SHARED = num(env.VYRE_WORK_GID, 1002);
const AGENT = { uid: num(env.VYRE_AGENT_UID, 1001), gid: num(env.VYRE_AGENT_GID, 1001), groups: [SHARED] };
const WORK = env.VYRE_WORK || "/work";
const SOCKET = env.VYRE_SPAWNER_SOCKET || "/run/vyre/spawner.sock";
const DAEMON = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "daemon", "main.js");
const log = m => process.stderr.write(`${new Date().toISOString()} ${m}\n`);

if (!process.getuid || process.getuid() !== 0) {
  await import(DAEMON);
} else {
  // As vyre, who owns them: /work goes to the shared group once (a volume made before the split),
  // with group write and setgid directories so new files keep it; vyred's home, which holds the
  // vault and Claude's sign-in, is closed to everyone else. No capability is needed for either.
  const asVyre = (...argv) => execFileSync("/usr/bin/setpriv", [`--reuid=${VYRE}`, `--regid=${VYRE}`, `--groups=${SHARED}`, "--inh-caps=-all", "--", ...argv], { stdio: "ignore" });
  try {
    const st = fs.statSync(WORK);
    if (st.gid !== SHARED || (st.mode & 0o2070) !== 0o2070) {
      log(`spawner: giving ${WORK} to group ${SHARED}`);
      asVyre("chgrp", "-R", String(SHARED), WORK);
      asVyre("chmod", "-R", "g+rwX", WORK);
      asVyre("find", WORK, "-type", "d", "-exec", "chmod", "g+s", "{}", "+");
    }
  } catch (e) { log(`spawner: ${WORK} is not fully shared: ${/** @type {Error} */ (e).message}`); }
  try { asVyre("chmod", "700", env.VYRE_USER_HOME || "/home/vyre"); } catch {}

  const allow = ["/usr/local/bin/claude", ...String(env.VYRE_SPAWNER_ALLOW || "").split(":").filter(p => p.startsWith("/"))];
  const srv = await serve({ socket: SOCKET, mode: 0o660, allow, work: WORK, agent: AGENT, home: env.VYRE_AGENT_HOME || "/home/vyre-agent", log });

  // vyred as uid vyre, in the shared group, with no capabilities, and knowing where to ask. Its
  // umask is 002, so what it writes in /work the agent can change too; its own files take group
  // vyre, which the agent is not in, behind a home only vyre enters.
  const child = spawn("/usr/bin/setpriv", [`--reuid=${VYRE}`, `--regid=${VYRE}`, `--groups=${SHARED}`, "--inh-caps=-all", "--",
    "/bin/sh", "-c", 'umask 002; exec "$@"', "sh", process.execPath, DAEMON], { stdio: "inherit", env: { ...env, HOME: env.VYRE_USER_HOME || "/home/vyre", VYRE_SPAWNER_SOCKET: SOCKET } });
  const pass = sig => { try { child.kill(sig); } catch {} };
  process.on("SIGTERM", () => pass("SIGTERM"));
  process.on("SIGINT", () => pass("SIGINT"));
  child.on("exit", async (code, signal) => { await srv.close(); process.exit(code ?? (signal ? 1 : 0)); });
}
