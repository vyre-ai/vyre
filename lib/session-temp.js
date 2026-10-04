// @ts-check
// lib/session-temp.js: where a session's temp folder lives, decided in ONE place (the Switchboard's sandboxFor and closeSocket, and any sandbox profile that must allow it, read it from here).
// It is OUTSIDE the Vyre home: the home holds the kernel's database, keys and vault and a sandbox never shows it to a session, so a folder inside it can never be handed over (the runner's
// HS-2 rule, a security finding, stays). The folder is a sibling of the home, `<home>.sessions/tmp/<session>`; VYRE_SESSIONS_DIR names another place (a packaged install mounts its own volume).
import path from "node:path";

/** @param {string} root the Vyre home @returns {string} the per-install sessions directory, beside the home */
export function sessionsRoot(root) {
  const set = process.env.VYRE_SESSIONS_DIR;
  if (set && path.isAbsolute(set)) return path.resolve(set);
  const home = path.resolve(String(root || "."));
  return path.join(path.dirname(home), `${path.basename(home)}.sessions`);
}

/** @param {string} root @param {string} id @returns {string} */
export const sessionTempDir = (root, id) => path.join(sessionsRoot(root), "tmp", String(id).replace(/[^\w-]/g, ""));
