// @ts-check
// vyre-core's entry, run by launchd as _vyre on a Mac (ADR 0040; the installer is phase 4).
//
//   node main.js serve   start the daemon
//   node main.js code    print a one-time code that enrolls the first key (the installer runs this)
//
// Settings come from the environment launchd gives it, never from the person's files:
//   VYRE_CORE_SOCKET  the socket (default /var/run/vyre/vyre-core.sock; /var/run/vyre is root-made, _vyre's, 0755)
//   VYRE_CORE_DATA    the data directory (default /Library/Application Support/Vyre/data)
//   VYRE_CORE_OWNER   the owner's uid (required)
//   VYRE_CORE_STRICT  "0" turns strict mode off (dev and Linux tests only); on by default on darwin

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCore, openStore, INSTALL_CODE } from "./server.js";
import { strictProblems } from "./strict.js";

// Nothing from the environment but these four, and a PATH core sets itself: a VYRE_* override
// or a PATH entry is exactly what someone else could have put there (ADR 0040 section 1).
const KEEP = new Set(["VYRE_CORE_SOCKET", "VYRE_CORE_DATA", "VYRE_CORE_OWNER", "VYRE_CORE_STRICT"]);
for (const k of Object.keys(process.env)) if ((k.startsWith("VYRE_") && !KEEP.has(k)) || /^(NODE_|PERL5|LD_|DYLD_)/.test(k)) delete process.env[k];
process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const env = process.env;
const socket = env.VYRE_CORE_SOCKET || "/var/run/vyre/vyre-core.sock";
const dataDir = env.VYRE_CORE_DATA || "/Library/Application Support/Vyre/data";
const owner = /^\d+$/.test(String(env.VYRE_CORE_OWNER || "")) ? Number(env.VYRE_CORE_OWNER) : null;
const strict = env.VYRE_CORE_STRICT === undefined ? process.platform === "darwin" : env.VYRE_CORE_STRICT !== "0";
// The version shipped beside this file, in core's own root-owned tree.
const version = (() => { try { return String(JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version); } catch { return null; } })();
const log = m => process.stderr.write(`${new Date().toISOString()} ${m}\n`);
const fail = m => { log(`vyre-core: ${m}`); process.exit(1); };

if (owner === null) fail("VYRE_CORE_OWNER must be the owner's uid");
if (strict) {
  const codeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const problems = strictProblems({ codeDir, dataDir, socketDir: path.dirname(socket), ownerUid: /** @type {number} */ (owner), uid: process.getuid ? process.getuid() : -1 });
  if (problems.length) fail(`won't start from here:\n  ${problems.join("\n  ")}`);
}

const cmd = process.argv[2] || "serve";
if (cmd === "code") {
  const { db, presence } = openStore(dataDir, { log });
  const { code, expires } = presence.mintCode(INSTALL_CODE);
  db.close();
  process.stdout.write(`${code} ${expires}\n`);
} else if (cmd === "serve") {
  const core = await startCore({ socket, dataDir, ownerUid: /** @type {number} */ (owner), version: version || undefined, log });
  const stop = () => core.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else fail(`unknown command ${cmd}`);
