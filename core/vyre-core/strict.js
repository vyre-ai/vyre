// @ts-check
// Strict mode: vyre-core refuses to start from a tree the person's uid could have written.
//
// ADR 0040 section 1: core's code is root-owned and writable by nobody else, not even _vyre, and
// its data directory is _vyre's own, 0700. A core started from anywhere else would be trusting
// code or state a model could have put there, so it doesn't start at all. On by default on a
// Mac; a test or a dev run on Linux turns it off, since there is no second uid to run it as.

import fs from "node:fs";
import path from "node:path";

/**
 * What stops core starting here, as plain sentences; an empty list means it may.
 * @param {{ codeDir: string, dataDir: string, socketDir?: string, ownerUid: number, uid: number, stat?: (p: string) => { uid: number, mode: number } }} o
 *   uid: the uid core runs as. stat: tests only.
 * @returns {string[]}
 */
export function strictProblems({ codeDir, dataDir, socketDir, ownerUid, uid, stat = p => fs.statSync(p) }) {
  const out = [];
  if (uid === ownerUid) out.push(`vyre-core runs as uid ${uid}, the owner's own uid: it needs its own account`);
  if (uid === 0) out.push("vyre-core must not run as root");
  // Every folder from here up to / must be root's and closed to group and other writes, or
  // someone could swap a folder in the path for one of their own.
  const upward = dir => {
    const dirs = [];
    for (let d = path.resolve(dir); ; d = path.dirname(d)) { dirs.push(d); if (d === path.dirname(d)) break; }
    return dirs;
  };
  const check = (p, want) => {
    let s;
    try { s = stat(p); } catch { out.push(`${p} does not exist`); return; }
    if (!want.includes(s.uid)) out.push(`${p} is owned by uid ${s.uid}, not ${want.map(u => (u === 0 ? "root" : `uid ${u}`)).join(" or ")}`);
    if (s.mode & 0o022) out.push(`${p} can be written by other users`);
  };
  for (const d of upward(codeDir)) check(d, [0]);
  const data = path.resolve(dataDir);
  check(data, [uid]);
  try { if (stat(data).mode & 0o077) out.push(`${data} must be readable by vyre-core alone (0700)`); } catch {}
  for (const d of upward(path.dirname(data))) check(d, [0]);
  // The socket's folder: core's own (or root's), so nobody else can put a socket of theirs there
  // for a client to hand its proof to.
  if (socketDir) {
    check(path.resolve(socketDir), [uid, 0]);
    for (const d of upward(path.dirname(path.resolve(socketDir)))) check(d, [0]);
  }
  return [...new Set(out)];
}
