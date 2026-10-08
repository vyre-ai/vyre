// @ts-check
// vyre-core's entry, run by launchd as _vyre on a Mac (ADR 0040; the installer is phase 4).
//
//   node main.js serve   start the daemon
//   node main.js code [--typed]  print a one-time code that enrolls the first key (the installer runs this)
//
// Settings come from the environment launchd gives it, never from the person's files:
//   VYRE_CORE_SOCKET  the socket (default /Library/Application Support/Vyre/run/vyre-core.sock; that folder is root-made, _vyre's, 0755, and not under /var/run, which macOS clears at boot)
//   VYRE_CORE_DATA    the data directory (default /Library/Application Support/Vyre/data)
//   VYRE_CORE_OWNER   the owner's uid (required)
//   VYRE_CORE_STRICT  "0" turns strict mode off (dev and Linux tests only); on by default on darwin
//   VYRE_CORE_SERVER  "1" when this Mac is a server (the installer's plist sets it): core then takes a first key by presence.enroll.first

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startCore, openStore, INSTALL_CODE, TYPED_CODE } from "./server.js";
import { strictProblems } from "./strict.js";
import { armFirstKey } from "./firstkey.js";

// Nothing from the environment but these five, and a PATH core sets itself: a VYRE_* override
// or a PATH entry is exactly what someone else could have put there (ADR 0040 section 1).
const KEEP = new Set(["VYRE_CORE_SOCKET", "VYRE_CORE_DATA", "VYRE_CORE_OWNER", "VYRE_CORE_STRICT", "VYRE_CORE_SERVER"]);
for (const k of Object.keys(process.env)) if ((k.startsWith("VYRE_") && !KEEP.has(k)) || /^(NODE_|PERL5|LD_|DYLD_)/.test(k)) delete process.env[k];
process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const env = process.env;
const socket = env.VYRE_CORE_SOCKET || "/Library/Application Support/Vyre/run/vyre-core.sock";
const dataDir = env.VYRE_CORE_DATA || "/Library/Application Support/Vyre/data";
const owner = /^\d+$/.test(String(env.VYRE_CORE_OWNER || "")) ? Number(env.VYRE_CORE_OWNER) : null;
const isServer = env.VYRE_CORE_SERVER === "1";
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
  // `code` for the fd handoff to the Capsule (2 minutes), `code --typed` for the fallback (10).
  // a server's installer also names the first key's fingerprint (public; the setup code's secret never comes here): core takes that one key within the hour
  const at = process.argv.indexOf("--first-key-fp");
  if (at > 0) {
    if (!isServer) fail("--first-key-fp is for a server's core");
    try { armFirstKey(db, String(process.argv[at + 1] || "")); } catch (e) { fail(/** @type {Error} */ (e).message); }
  }
  const { code, expires } = presence.mintCode(process.argv[3] === "--typed" ? TYPED_CODE : INSTALL_CODE);
  db.close();
  process.stdout.write(`${code} ${expires}\n`);
} else if (cmd === "serve") {
  // dev: only a non-strict start (VYRE_CORE_STRICT=0, never a Mac default) lets the Linux
  // stand-in for the signed-Capsule check say yes.
  const core = await startCore({ socket, dataDir, ownerUid: /** @type {number} */ (owner), version: version || undefined, log, dev: !strict && process.platform !== "darwin", server: isServer });
  const stop = () => core.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else fail(`unknown command ${cmd}`);
