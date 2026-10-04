// kernel/seal/wipe.js: reset with wipe, the sealing side. Run by the host CLI (`sudo vyre admin wipe`) with the daemon and the sealing process STOPPED; never a tool, never reachable from the
// daemon or a session. The master key goes first (overwritten, then removed), which makes every file left in the folder (values, derived outputs, presence, the Space checkpoint key, the
// anchor, the pool and kernel MAC keys) open for no one even if a later step fails; then the folder's contents go. A fresh start makes a new master and a new Space key.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** @param {string} dir the sealing folder (`<home>/seal`) @returns {{ master_destroyed: boolean, removed: number }} */
export function wipeSealDir(dir) {
  const mk = path.join(dir, "master.key");
  let destroyed = false;
  try { const n = fs.statSync(mk).size, fd = fs.openSync(mk, "r+"); fs.writeSync(fd, crypto.randomBytes(Math.max(n, 32))); fs.fsyncSync(fd); fs.closeSync(fd); destroyed = true; } catch { /* no file master here (an OS keystore master is deleted by its own custody step) */ }
  fs.rmSync(mk, { force: true });
  let removed = 0;
  if (fs.existsSync(dir)) for (const e of fs.readdirSync(dir, { withFileTypes: true })) { fs.rmSync(path.join(dir, e.name), { recursive: true, force: true }); removed++; }
  return { master_destroyed: destroyed, removed };
}
