// @ts-check
// The box container's process under tini (ADR 0032 part 3, ADR 0029 R4). The tree:
//   tini (PID 1, the one init) -> this spawner (root: SETUID, SETGID, KILL)
//     -> loop.sh as uid vyre -> vyred           (the loop restarts vyred; terminals outlive it)
//     -> tini -s -> claude as uid vyre-agent    (one per Vyre-owned session, when vyred asks)
// As root it shares /work with the agent's group once, opens the spawner's socket for vyred, and
// runs the loop as vyre. Not root (a plain docker run, as vyre): it runs the loop itself, and
// sessions spawn directly. It never adds an init of its own; the nested tini is a subreaper for
// one session's tree, not a second PID 1.

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
const LOOP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "daemon", "loop.sh");
const log = m => process.stderr.write(`${new Date().toISOString()} ${m}\n`);

/** Run the loop (argv, env) and live as long as it does, passing tini's signals on. */
function runLoop(argv, env2) {
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env: env2 });
  const pass = sig => { try { child.kill(sig); } catch {} };
  process.on("SIGTERM", () => pass("SIGTERM"));
  process.on("SIGINT", () => pass("SIGINT"));
  return child;
}

if (!process.getuid || process.getuid() !== 0) {
  const child = runLoop(["/bin/sh", LOOP], env);
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
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

  // Claude Code: the global install, and the Agent SDK's own binary (ADR 0030) where it is bundled.
  const sdk = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@anthropic-ai");
  let bundled = [];
  try { bundled = fs.readdirSync(sdk).filter(n => /^claude-agent-sdk-linux-/.test(n)).map(n => path.join(sdk, n, "claude")).filter(p => fs.existsSync(p)); } catch {}
  const allow = ["/usr/local/bin/claude", ...bundled, ...String(env.VYRE_SPAWNER_ALLOW || "").split(":").filter(p => p.startsWith("/"))];
  const home = env.VYRE_AGENT_HOME || "/home/vyre-agent";
  const makeDir = dir => execFileSync("/usr/bin/setpriv", [`--reuid=${AGENT.uid}`, `--regid=${AGENT.gid}`, `--groups=${SHARED}`, "--inh-caps=-all", "--",
    "/bin/sh", "-c", 'umask 002; exec mkdir -p "$1"', "sh", dir], { stdio: "ignore" });
  const srv = await serve({ socket: SOCKET, mode: 0o660, allow, work: WORK, agent: AGENT, home, makeDir, log });

  // The loop, and so vyred, as uid vyre, in the shared group, with no capabilities, and knowing
  // where to ask. Its umask is 002, so what it writes in /work the agent can change too; its own
  // files take group vyre, which the agent is not in, behind a home only vyre enters.
  const child = runLoop(["/usr/bin/setpriv", `--reuid=${VYRE}`, `--regid=${VYRE}`, `--groups=${SHARED}`, "--inh-caps=-all", "--",
    "/bin/sh", "-c", 'umask 002; exec "$@"', "sh", "/bin/sh", LOOP], { ...env, HOME: env.VYRE_USER_HOME || "/home/vyre", VYRE_SPAWNER_SOCKET: SOCKET });
  child.on("exit", async (code, signal) => { await srv.close(); process.exit(code ?? (signal ? 1 : 0)); });
}
