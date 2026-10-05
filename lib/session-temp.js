// @ts-check
// lib/session-temp.js: where a session's temp folder lives, decided in ONE place (the Switchboard's sandboxFor and closeSocket, and any sandbox profile that must allow it, read it from here).
// It is OUTSIDE the Vyre home: the home holds the kernel's database, keys and vault and a sandbox never shows it to a session, so a folder inside it can never be handed over (the runner's
// HS-2 rule, a security finding, stays). The folder is a sibling of the home, `<home>.sessions/tmp/<session>`; VYRE_SESSIONS_DIR names another place (a packaged install mounts its own volume).
import fs from "node:fs";
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

/**
 * The folder a session saves what it makes in ($VYRE_ARTIFACTS_DIR), made by vyred and outside the Vyre home (artifacts refuses a folder inside it, and a sandbox never shows the home to a session).
 *   - A session in a sandbox (bubblewrap, seatbelt) writes its own temp folder and nothing else of the machine, so the folder is `<session temp>/artifacts`.
 *   - A session that runs as another user (the packaged box: its own uid, no wrapper) cannot enter vyred's 0700 temp folder, so the folder is `<sessions dir>/artifacts/<id>`, reached through folders
 *     that are searchable but not listable (0711) and owned by that uid at the end, which is the only place it can write. `chown` is the privileged step: where vyred may not do it (a development
 *     run as one user) the folder stays vyred's and the answer says so (`handed: false`).
 * Every folder is a real one (no link anywhere in its path), mode 0700 where the session writes. Null when it cannot be made.
 * @param {string} root the Vyre home @param {string} id the thread @param {{ uid?: number | null, gid?: number | null }} [as] the user the session runs as, when it is not vyred's
 * @returns {{ dir: string, handed: boolean } | null}
 */
export function artifactsDirFor(root, id, as = {}) {
  const clean = String(id).replace(/[^\w-]/g, "");
  if (!clean) return null;
  try {
    const split = as.uid !== undefined && as.uid !== null;
    const base = split ? path.join(sessionsRoot(root), "artifacts") : sessionTempDir(root, clean);
    fs.mkdirSync(base, { recursive: true, mode: split ? 0o711 : 0o700 });
    if (split) { try { fs.chmodSync(sessionsRoot(root), 0o711); fs.chmodSync(base, 0o711); } catch { /* not ours to change */ } }
    const dir = path.join(fs.realpathSync(base), split ? clean : "artifacts");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    let handed = !split;
    if (split) { try { fs.chownSync(dir, /** @type {number} */ (as.uid), as.gid ?? /** @type {number} */ (as.uid)); handed = true; } catch { handed = false; } }
    return { dir, handed };
  } catch { return null; }
}
