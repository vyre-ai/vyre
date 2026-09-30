// @ts-check
// Private to the signed-in person on Windows. Node's mode bits (0700, 0600) mean nothing there: a
// file gets the ACL its parent folder passes down. Under the user profile that is already private,
// but a home kept elsewhere (another drive, a shared folder) inherits whoever the parent lets in.
// So on win32 this grants the current user alone (by SID, so a renamed or localized account cannot
// break it) on the folder and everything made inside it afterwards, then removes inherited access.
// That is stricter than a default profile: SYSTEM and Administrators lose access too, so a backup
// or antivirus tool running as SYSTEM will not read this folder. Elsewhere it does nothing: the mode
// bits already work. Best effort on purpose: a machine without icacls still starts, and the profile
// default holds.
//
// Windows' own tools are run from %SystemRoot%\System32 by full path, never by name, so a
// hostile icacls.exe sitting in the working directory is never run.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const done = new Set();

/** The Windows folder, from SystemRoot only when it is a drive path, else C:\Windows. */
export function systemRoot(env = process.env) {
  const r = env.SystemRoot || env.windir || "";
  return /^[A-Za-z]:\\/.test(r) ? r : "C:\\Windows";
}

const tool = (name, env = process.env) => `${systemRoot(env)}\\System32\\${name}`;

/** The current user's SID from `whoami /user /fo csv /nh` output (`"DOMAIN\\name","S-1-5-21-..."`). */
export function sidFromWhoami(out) {
  const m = /"(S-1-[0-9-]+)"/.exec(String(out));
  return m ? m[1] : null;
}

/** The icacls arguments: grant this SID, in two calls so a failed grant never removes existing access. */
export function ownerOnlyArgs(target, sid, isDir = true) {
  return [
    [target, "/grant:r", isDir ? `*${sid}:(OI)(CI)F` : `*${sid}:F`],
    [target, "/inheritance:r"],
  ];
}

/** Trustees that mean "other people" in an SDDL ACL: Everyone, Users, Authenticated Users (by letters and SIDs). */
const OTHERS = new Set(["WD", "BU", "AU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11"]);

/** Pure: whether an SDDL string (from `icacls /save`) grants nothing to Everyone, Users or Authenticated Users. */
export function sddlIsOwnerOnly(sddl) {
  for (const m of String(sddl).matchAll(/\((A|OA|D|OD|AU|AL|OU|ML);[^;]*;[^;]*;[^;]*;[^;]*;([^)]*)\)/g)) {
    if (m[1] !== "A" && m[1] !== "OA") continue;
    if (OTHERS.has(m[2].toUpperCase())) return false;
  }
  return true;
}

/** The SDDL of `target`, language-independent: icacls /save writes it to a temp file (UTF-16). */
export function sddlOf(target, run = execFileSync, env = process.env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-acl-"));
  const out = path.join(dir, "acl.txt");
  try {
    run(tool("icacls.exe", env), [target, "/save", out], { stdio: "ignore", timeout: 10_000, windowsHide: true });
    return fs.readFileSync(out).toString("utf16le");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Restrict a folder (or file) to the current user. Returns true when it is restricted and verified. */
export function ownerOnly(target, isDir = true, platform = process.platform, run = execFileSync, env = process.env) {
  if (platform !== "win32") return false;
  if (done.has(target)) return true;
  try {
    const sid = sidFromWhoami(run(tool("whoami.exe", env), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 10_000, windowsHide: true }));
    if (!sid) return false;
    for (const args of ownerOnlyArgs(target, sid, isDir)) run(tool("icacls.exe", env), args, { stdio: "ignore", timeout: 10_000, windowsHide: true });
    if (run === execFileSync && !isOwnerOnly(target, platform)) return false;   // verified, not assumed
    done.add(target);
    return true;
  } catch { return false; }
}

/** Whether nobody in Everyone, Users or Authenticated Users can reach `target` (win32 only; true elsewhere). */
export function isOwnerOnly(target, platform = process.platform, run = execFileSync, env = process.env) {
  if (platform !== "win32") return true;
  return sddlIsOwnerOnly(sddlOf(target, run, env));
}
