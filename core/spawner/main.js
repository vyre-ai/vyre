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
import { readStatus, holdsNetAdmin, recheck, POOL } from "./wall.js";

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
    // Closed to every other uid (2770): the watcher pool and anything else that is not vyred or the shared group cannot enter it.
    // Only the folder itself: whatever is inside is unreachable without passing through it.
    if ((st.mode & 0o007) !== 0) asVyre("chmod", "o-rwx", WORK);
  } catch (e) { log(`spawner: ${WORK} is not fully shared: ${/** @type {Error} */ (e).message}`); }
  try { asVyre("chmod", "700", env.VYRE_USER_HOME || "/home/vyre"); } catch {}
  // The accounts folder is entered, never listed: a session's uid learns no other account's uid from it (each home is closed to everyone else). vyred and the spawner need only to pass through.
  try { fs.chmodSync(env.VYRE_ACCOUNTS_HOME || "/home/acct", 0o711); } catch (e) { log(`spawner: ${env.VYRE_ACCOUNTS_HOME || "/home/acct"} could not be made unlistable: ${/** @type {Error} */ (e).message}`); }

  // Claude Code: the global install, and the Agent SDK's own binary (ADR 0030) where it is bundled.
  // It lives in the image's own node_modules, or where sessions installs it (/opt/vyre-sessions-sdk).
  const bundled = [];
  for (const base of [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), "/opt/vyre-sessions-sdk", env.VYRE_SESSIONS_SDK_DIR || ""].filter(Boolean)) {
    const sdk = path.join(base, "node_modules", "@anthropic-ai");
    try { for (const n of fs.readdirSync(sdk)) if (/^claude-agent-sdk-linux-/.test(n) && fs.existsSync(path.join(sdk, n, "claude"))) bundled.push(path.join(sdk, n, "claude")); } catch {}
  }
  // The image's own Codex (and its ACP adapter) and Grok Build, for sign-in and for sessions as an account's uid (box/Dockerfile pins them).
  // confine-probe.sh: the fixed, read-only self-test of a session's own uid (core/spawner/confine.js); it only reports what its uid can reach.
  const allow = ["/usr/local/bin/claude", "/usr/local/bin/codex", "/usr/local/bin/codex-acp", "/usr/local/bin/grok", path.join(path.dirname(fileURLToPath(import.meta.url)), "confine-probe.sh"), ...bundled, ...String(env.VYRE_SPAWNER_ALLOW || "").split(":").filter(p => p.startsWith("/"))];
  const home = env.VYRE_AGENT_HOME || "/home/vyre-agent";
  const makeDir = (dir, who) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, who.groups.length ? `--groups=${who.groups.join(",")}` : "--clear-groups", "--inh-caps=-all", "--",
    "/bin/sh", "-c", 'umask 002; exec mkdir -p "$1"', "sh", dir], { stdio: "ignore" });
  // One uid per account, 2000-2063 in the image, each with a private HOME in the vyre-accounts volume.
  const accounts = { min: num(env.VYRE_ACCOUNT_UID_MIN, 2000), max: num(env.VYRE_ACCOUNT_UID_MAX, 2063), home: env.VYRE_ACCOUNTS_HOME || "/home/acct", shared: [SHARED] };
  const grantGroup = (dir, who) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--inh-caps=-all", "--", "/bin/chmod", "710", dir], { stdio: "ignore" });
  // The watcher wall: pool uids, their folders, and the status the entry script wrote after installing and probing the rule.
  const watcher = { min: num(env.VYRE_WATCH_UID_MIN, POOL.min), max: num(env.VYRE_WATCH_UID_MAX, POOL.max), home: env.VYRE_WATCH_HOME || "/run/vyre-watch",
    allow: [env.VYRE_WATCH_NODE || "/usr/local/bin/node"], status: () => readStatus(env.VYRE_WALL_STATUS), heldCap: holdsNetAdmin, reprobe: () => recheck() };
  const srv = await serve({ socket: SOCKET, mode: 0o660, allow, work: WORK, agent: AGENT, home, makeDir, grantGroup, accounts, watcher, log });

  // The loop, and so vyred, as uid vyre, in the shared group, with no capabilities, and knowing
  // where to ask. Its umask is 002, so what it writes in /work the agent can change too; its own
  // files take group vyre, which the agent is not in, behind a home only vyre enters.
  // vyred is in every account's group (gid = uid, 2000-2063), so it can read each account's
  // transcripts through the group and no account can read another's.
  const accountGids = []; for (let g = accounts.min; g <= accounts.max; g++) accountGids.push(g);
  const child = runLoop(["/usr/bin/setpriv", `--reuid=${VYRE}`, `--regid=${VYRE}`, `--groups=${[SHARED, ...accountGids].join(",")}`, "--inh-caps=-all", "--",
    "/bin/sh", "-c", 'umask 002; exec "$@"', "sh", "/bin/sh", LOOP], { ...env, HOME: env.VYRE_USER_HOME || "/home/vyre", VYRE_SPAWNER_SOCKET: SOCKET });
  child.on("exit", async (code, signal) => { await srv.close(); process.exit(code ?? (signal ? 1 : 0)); });
}
