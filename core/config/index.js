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
    models: path.join(root, "models"),
    certs: path.join(root, "certs"),
    names: path.join(root, "names"),
    env: path.join(root, "env"),
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

/** @typedef {{ tailscale: boolean, address?: string, owner?: string, domain?: string, via?: "vyre.run"|"ts.net",
 *   port?: number, acme?: "production"|"staging", box?: string, onboardPort?: number, ownerSeen?: string,
 *   guests?: { enabled: boolean, people: Record<string, { tools: string[] }> } }} Network
 * address is the https URL the Deck is served at; owner the one Tailscale login served there (ADR 0002);
 * guests the people from other tailnets it also serves, each limited to its tools (ADR 0014 part 8). */

/** @typedef {{ name?: string, role: "box"|"local", projectsDir: string, roots: string[],
 *   me: { domains: string[], emails: string[] }, transcripts: string[],
 *   modules: { enable: string[], disable: string[] }, network: Network, onboard?: any,
 *   glass: { roots?: string[], egress: { enabled: boolean, sites: string[] } },
 *   computers: { tailnet: { enabled: boolean, tag: string }, [k: string]: any },
 *   hooks: { enabled: boolean, port: number, routes: Record<string, { scheme: string, header: string, secret: string, opened?: string }> } }} Config */

/** Defaults: one person on one Mac, nothing enabled that needs setting up. */
function defaults() {
  return {
    role: process.platform === "darwin" ? "local" : "box",
    projectsDir: path.join(os.homedir(), "Vyre", "projects"),
    roots: [],
    me: { domains: [], emails: [] },
    transcripts: [path.join(os.homedir(), ".claude", "projects"), path.join(os.homedir(), ".claude", "projects-archive")],
    modules: { enable: [], disable: [] },
    // Guests from another tailnet: off, nobody listed (ADR 0014 part 8, core/names/guests.js).
    network: { tailscale: false, guests: { enabled: false, people: {} } },
    // Off: no computer's Chrome goes out through the user's Mac until the owner lists sites
    // (core/computers/egress.js, box/compose.egress.yml).
    glass: { egress: { enabled: false, sites: [] } },
    // Off: no computer joins the tailnet as its own node until the owner turns it on
    // (core/computers/tailnet.js, ADR 0014 part 9).
    computers: { tailnet: { enabled: false, tag: "tag:vyre-agent" } },
    // Off: no webhook listener until the owner turns it on and opens a route (core/hooks).
    hooks: { enabled: false, port: 7310, routes: {} },
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
    glass: { ...d.glass, ...(user.glass || {}), egress: { ...d.glass.egress, ...((user.glass && user.glass.egress) || {}) } },
    computers: { ...d.computers, ...(user.computers || {}), tailnet: { ...d.computers.tailnet, ...((user.computers && user.computers.tailnet) || {}) } },
    hooks: { ...d.hooks, ...(user.hooks || {}) },
  };
  c.projectsDir = untilde(c.projectsDir);
  c.roots = (c.roots || []).map(untilde);
  c.transcripts = (c.transcripts || []).map(untilde);
  if (!["box", "local"].includes(c.role)) { problems.push(`role "${c.role}" is not box or local; using ${d.role}`); c.role = d.role; }
  return { ...c, problems };
}

/**
 * Merge a change into config.json and write it atomically at 0600. Only what the user or the
 * onboarding set is written, never the defaults. Objects merge one level deep (network, me, ...);
 * a key set to null is removed. `live`, when given, is a loaded config to update in place.
 * @param {Record<string, any>} patch
 * @param {string} [root]
 * @param {Record<string, any>} [live]
 */
export function save(patch, root = home(), live) {
  const p = paths(root);
  let user = {};
  try { user = JSON.parse(fs.readFileSync(p.config, "utf8")); } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw e; }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete user[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && user[k] && typeof user[k] === "object" && !Array.isArray(user[k])) {
      user[k] = { ...user[k], ...v };
      for (const [kk, vv] of Object.entries(v)) if (vv === null) delete user[k][kk];
    } else user[k] = v;
  }
  fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
  const tmp = `${p.config}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(user, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p.config);
  // vyred's modules share one loaded config object; mirror the change into it so they all see it.
  if (live) for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete live[k];
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      live[k] = { ...(live[k] || {}), ...v };
      for (const [kk, vv] of Object.entries(v)) if (vv === null) delete live[k][kk];
    } else live[k] = v;
  }
  return user;
}

/** Create the data folders if they are missing. Safe to call every start. */
export function ensure(root = home()) {
  const p = paths(root);
  for (const dir of [p.root, p.vault, p.modules, p.watchers, p.logs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (path.dirname(p.socket) !== p.root) privateSocketDir();
  return p;
}
