// @ts-check
// Is this connecting process the Capsule vyre-core signed? On a Mac: its executable is the one inside
// core's own root-owned code tree (<tree>/Vyre.app/Contents/MacOS/Vyre), the app the installer signed
// (signing.js, hardened runtime, so nothing can be injected into it). Nobody but root can put a file
// there, so a copy anywhere else, however it is signed, is not the Capsule. The path is what the kernel
// says the process is running (ps), resolved through links, never what its argv claims.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CAPSULE_APP } from "./signing.js";

/** @param {number} pid @returns {string | null} */
function psPath(pid) {
  try { return execFileSync("/bin/ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", env: {}, timeout: 3000 }).trim() || null; } catch { return null; }
}

/**
 * @param {{ codeDir: string, exeOf?: (pid: number) => string | null }} o
 * @returns {(pid: number) => Promise<boolean>}
 */
export function capsuleFromTree({ codeDir, exeOf = psPath }) {
  return async pid => {
    const seen = exeOf(pid);
    if (!seen) return false;
    try {
      const want = fs.realpathSync(path.join(codeDir, CAPSULE_APP, "Contents", "MacOS", path.basename(CAPSULE_APP, ".app")));
      return fs.realpathSync(seen) === want;
    } catch { return false; }
  };
}
