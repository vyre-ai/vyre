// @ts-check
// config — where Vyre keeps things, and the user's settings.
//
// Everything personal lives under VYRE_HOME (default ~/.vyre), never in the repository. The
// same code serves anyone who installs it: which folders hold projects, which domains are the
// user's own, whether this machine is the box or the Mac, all come from ~/.vyre/config.json.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Resolve a leading ~ against the home directory. */
export function untilde(p) {
  return String(p).replace(/^~(?=$|\/)/, os.homedir());
}

/** The folder Vyre keeps its data in. Tests point VYRE_HOME at a temp folder. */
export function home() {
  return path.resolve(untilde(process.env.VYRE_HOME || path.join(os.homedir(), ".vyre")));
}

/** Every path Vyre uses, derived from home(). */
export function paths(root = home()) {
  return {
    root,
    config: path.join(root, "config.json"),
    db: path.join(root, "vyre.db"),
    vault: path.join(root, "vault"),
    modules: path.join(root, "modules"),
    watchers: path.join(root, "watchers"),
    logs: path.join(root, "logs"),
    sessions: path.join(root, "sessions"),                  // a bound session's key, per claude pid (core/switchboard/sessions.js)
    socket: socketPath(root),
    pid: path.join(root, "vyred.pid"),
  };
}

/**
 * Where vyred's socket lives. Normally ~/.vyre/vyred.sock. A unix socket path is limited to
 * about 104 bytes (macOS) or 108 (Linux), so a long VYRE_HOME puts it instead in a private
 * per-user folder under /tmp, named by a hash of the home. /tmp is shared, so the folder must
 * be ours and closed to everyone else; otherwise another user could plant a socket there and
 * pose as vyred. `privateSocketDir` checks that before anything uses it.
 */
export function socketPath(root) {
  const near = path.join(root, "vyred.sock");
  if (Buffer.byteLength(near) <= 100) return near;
  const hash = crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
  return path.join(sharedSocketDir(), `${hash}.sock`);
}

const sharedSocketDir = () => path.join("/tmp", `vyre-${typeof process.getuid === "function" ? process.getuid() : "user"}`);

/** Make (or check) the private /tmp folder for sockets. Throws if it is not safely ours. */
export function privateSocketDir() {
  const dir = sharedSocketDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  const mine = typeof process.getuid !== "function" || st.uid === process.getuid();
  if (!st.isDirectory() || !mine || (st.mode & 0o077) !== 0) {
    throw new Error(`${dir} is not a private folder owned by this user; refusing to put vyred's socket there`);
  }
  return dir;
}

/** @typedef {{ name?: string, role: "box"|"local", projectsDir: string, roots: string[],
 *   me: { domains: string[], emails: string[] }, transcripts: string[],
 *   modules: { enable: string[], disable: string[] }, network: { tailscale: boolean, address?: string } }} Config */

/** Defaults: one person on one Mac, nothing enabled that needs setting up. */
function defaults() {
  return {
    role: process.platform === "darwin" ? "local" : "box",
    projectsDir: path.join(os.homedir(), "Vyre", "projects"),
    roots: [],
    me: { domains: [], emails: [] },
    transcripts: [path.join(os.homedir(), ".claude", "projects"), path.join(os.homedir(), ".claude", "projects-archive")],
    modules: { enable: [], disable: [] },
    network: { tailscale: false },
  };
}

/**
 * The user's settings, merged over the defaults. A missing or unreadable file is not an error:
 * a fresh install has none, and a broken one should not stop vyred from starting, so it is
 * reported through `problems` and the defaults are used.
 * @returns {Config & { problems: string[] }}
 */
export function load(root = home()) {
  const p = paths(root);
  const problems = [];
  let user = {};
  try { user = JSON.parse(fs.readFileSync(p.config, "utf8")); }
  catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") problems.push("config.json unreadable: " + /** @type {Error} */ (e).message); }
  const d = defaults();
  const c = {
    ...d, ...user,
    me: { ...d.me, ...(user.me || {}) },
    modules: { ...d.modules, ...(user.modules || {}) },
    network: { ...d.network, ...(user.network || {}) },
  };
  c.projectsDir = untilde(c.projectsDir);
  c.roots = (c.roots || []).map(untilde);
  c.transcripts = (c.transcripts || []).map(untilde);
  if (!["box", "local"].includes(c.role)) { problems.push(`role "${c.role}" is not box or local; using ${d.role}`); c.role = d.role; }
  return { ...c, problems };
}

/** Create the data folders if they are missing. Safe to call every start. */
export function ensure(root = home()) {
  const p = paths(root);
  for (const dir of [p.root, p.vault, p.modules, p.watchers, p.logs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (path.dirname(p.socket) !== p.root) privateSocketDir();
  return p;
}
