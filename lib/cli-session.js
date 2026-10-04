// @ts-check
// The command line's person session credential (`vyre signin`): one 0600 file in the home. It is only a bearer secret; the daemon honours it only from the terminal login it was made for
// (core/signin), so reading the file from another process gives nothing. Sent by the daemon client on every cli call.

import fs from "node:fs";
import path from "node:path";
import * as config from "../core/config/index.js";

/** @param {string} [root] */
export const sessionFile = root => path.join(root ?? config.home(), "cli-session");

/** The credential, or null. @param {string} [root] */
export function readSession(root) {
  try {
    const t = fs.readFileSync(sessionFile(root), "utf8").trim();
    return /^[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{16,128}$/.test(t) ? t : null;
  } catch { return null; }
}

/** @param {string} token @param {string} [root] */
export function writeSession(token, root) {
  const f = sessionFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + "\n", { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** @param {string} [root] */
export function clearSession(root) { try { fs.rmSync(sessionFile(root), { force: true }); } catch { /* none */ } }
