// @ts-check
// Private to the signed-in person on Windows. Node's mode bits (0700, 0600) mean nothing there: a
// file gets the ACL its parent folder passes down. Under the user profile that is already private,
// but a home kept elsewhere (another drive, a shared folder) inherits whoever the parent lets in.
// So on win32 this removes inherited access and grants the current user alone, on the folder and
// everything made inside it afterwards. Elsewhere it does nothing: the mode bits already work.
// Best effort on purpose: a machine without icacls still starts, and the profile default holds.

import { execFileSync } from "node:child_process";
import os from "node:os";

const done = new Set();

/** The icacls arguments that leave `target` to `user` alone. Pure, so it is tested anywhere. */
export function ownerOnlyArgs(target, user, isDir = true) {
  return [target, "/inheritance:r", "/grant:r", isDir ? `${user}:(OI)(CI)F` : `${user}:F`];
}

/** Restrict a folder (or file) to the current user. Returns true when it is restricted. */
export function ownerOnly(target, isDir = true, platform = process.platform, run = execFileSync) {
  if (platform !== "win32") return false;
  if (done.has(target)) return true;
  try {
    const user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;
    run("icacls", ownerOnlyArgs(target, user, isDir), { stdio: "ignore", timeout: 10_000, windowsHide: true });
    done.add(target);
    return true;
  } catch { return false; }
}

/** Whether nobody but the current user, SYSTEM and Administrators can reach `target` (win32 only; true elsewhere). */
export function isOwnerOnly(target, platform = process.platform, run = execFileSync) {
  if (platform !== "win32") return true;
  const out = String(run("icacls", [target], { encoding: "utf8", windowsHide: true }));
  return !/\b(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)\b/i.test(out);
}
