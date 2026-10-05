// @ts-check
// config — where Vyre keeps things, and the user's settings.
//
// Everything personal lives under VYRE_HOME (default ~/.vyre), never in the repository. The
// same code serves anyone who installs it: which folders hold projects, which domains are the
// user's own, whether this machine is the box or the Mac, all come from ~/.vyre/config.json.

import "../../lib/mac-test-refusal.js";
import crypto from "node:crypto";
import { ownerOnly } from "../../lib/owner-only.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHome, claudeJson, transcriptFolders } from "./dialogs.js";
import { fingerprint8 as fingerprint8Bytes, toBase64url } from "../../lib/identity.js";

export { claudeHome, claudeJson, transcriptFolders };

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
 *
 * On `win32` this is a literal named pipe name, never a filesystem path, and deliberately not
 * one: a bound socket *file* on Windows is implemented as an NTFS reparse point, which needs
 * `SeCreateSymbolicLinkPrivilege` to create, a privilege most Windows accounts don't hold
 * (proven in CI, ADR 0037's Windows LOW: a from-scratch bind attempt failed with EACCES on a
 * brand-new folder with no ACL applied at all, `whoami /priv` showed the privilege Disabled, and
 * a literal `\\.\pipe\` bind in the same process succeeded immediately). A named pipe needs no
 * privilege and no folder to protect: Node gives it a current-user-only security descriptor by
 * default (the same restriction `chmod 0600` gives the POSIX socket), unless
 * `readableAll`/`writableAll` is passed to `listen()`, which nothing here does.
 *
 * The name itself is never just a hash of `root`: `root` is normally a predictable path
 * (`~/.vyre`), so another local account that can guess or enumerate it could compute the same
 * pipe name and pre-create it before the real `vyred` starts (reviewer, ADR 0037's Windows LOW,
 * section 7a point 2 - a squatter who owns the name receives the CLI's requests, including
 * presence proof headers). `pipeToken` folds in a random component nothing outside this home can
 * derive, generated once and persisted so the name is stable across restarts, the same as the
 * hash-only name was.
 * @param {string} root @param {{ platform?: string }} [opts] `platform` is for a test on any OS.
 */
export function socketPath(root, { platform = process.platform } = {}) {
  // The real folder, so a home reached through a symlink has the same socket as its target.
  const real = realFolder(root);
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
  if (platform === "win32") return `\\\\.\\pipe\\vyre-${hash}-${pipeToken(root)}`;
  const near = path.join(real, "vyred.sock");
  if (Buffer.byteLength(near) <= 100) return near;
  return path.join(sharedSocketDir(), `${hash}.sock`);
}

/**
 * A random component for `win32`'s pipe name, unguessable from `root` alone, generated once and
 * kept at `<root>/pipe-token` (a sibling of `config.json`, inside the home's own folder, never a
 * shared location like `/tmp`'s POSIX fallback). Read if it exists; created (and `root` made, if
 * it isn't there yet) on first use. Every call for the same `root` returns the same token, the
 * same idempotence `socketPath`'s hash-only name had before this.
 * @param {string} root
 */
function pipeToken(root) {
  const file = path.join(root, "pipe-token");
  const read = () => { try { return fs.readFileSync(file, "utf8").trim(); } catch { return ""; } };
  const have = read();
  if (have) return have;
  fs.mkdirSync(root, { recursive: true });
  ownerOnly(root);
  const token = crypto.randomBytes(16).toString("hex");
  // Created exclusively: vyred and a client reading the same home at the same moment must end up with ONE
  // token. A plain write let each make its own and the last writer win, so the one that read first held a
  // pipe name the other never listened on (a flaky "vyred did not create its socket" on a loaded runner).
  try {
    fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" });
    return token;
  } catch (e) {
    if (/** @type {any} */ (e).code !== "EEXIST") throw e;
  }
  // The other writer created it first and may not have written yet: wait for its token.
  for (let i = 0; i < 100; i++) {
    const t = read();
    if (t) return t;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  // Still empty: its writer died between creating and writing. An empty file that old is nobody's
  // token; remove it and make one (once), so a crash cannot wedge every later start.
  try { if (fs.statSync(file).size === 0 && Date.now() - fs.statSync(file).mtimeMs > 2000) fs.rmSync(file, { force: true }); } catch {}
  try { fs.writeFileSync(file, token, { mode: 0o600, flag: "wx" }); return token; } catch {}
  const t = read();
  if (t) return t;
  throw new Error(`${file} exists but holds no token`);
}

/** A folder's real path; for one not made yet, its nearest existing parent's real path plus the rest. */
function realFolder(/** @type {string} */ p) {
  const abs = path.resolve(p);
  const rest = [];
  for (let at = abs; ; at = path.dirname(at)) {
    try { return path.join(fs.realpathSync(at), ...rest.reverse()); }
    catch { if (path.dirname(at) === at) return abs; rest.push(path.basename(at)); }
  }
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
 *   port?: number, acme?: "production"|"staging", box?: string, onboardPort?: number, ownerSeen?: string, origins?: string[],
 *   guests?: { enabled: boolean, people: Record<string, { tools: string[] }> } }} Network
 * address is the https URL the Deck is served at; owner the one Tailscale login served there (ADR 0002);
 * guests the people from other tailnets it also serves, each limited to its tools (ADR 0014 part 8). */

/**
 * Whether a machine plays the server's part: the eight box-only modules, an always-on presence,
 * the owner's Deck served from here, a real address other devices reach. True only for
 * `config.machine` "server", and for the legacy `config.role` value "box".
 *
 * NOT true for "solo" (fixed 28 Sep after reviewer's HOLD on 80fd866e): a first pass made solo
 * both a server and a device, which put the eight box-only modules -- the tailnet listener,
 * public webhooks, the relay, the owner-claim flow -- on every existing Mac by default, with no
 * choice made. Solo is the full local core and nothing that exposes this machine to anyone else;
 * a person turns individual server parts on by choosing them (pairing a device, `vyre server
 * here`), never by installing Vyre on a Mac.
 * @param {string} [machine]
 */
export function isServer(machine) { return machine === "server" || machine === "box"; }

/**
 * Whether a machine is a device, of a server elsewhere or (under "solo") of no one: the
 * local-only modules, Capsule, voice, presence's Mac rules. True for `config.machine` "device"
 * and "solo", and for the legacy `config.role` value "local".
 * @param {string} [machine]
 */
export function isDevice(machine) { return machine === "device" || machine === "solo" || machine === "local"; }

/** @typedef {{ name?: string, role: "box"|"local", machine: "solo"|"server"|"device", projectsDir: string, roots: string[],
 *   me: { domains: string[], emails: string[] }, transcripts: string[],
 *   modules: { enable: string[], disable: string[] }, network: Network, onboard?: any, owner?: { id: string },
 *   glass: { roots?: string[], egress: { enabled: boolean, sites: string[] } },
 *   computers: { tailnet: { enabled: boolean, tag: string }, [k: string]: any },
 *   hooks: { enabled: boolean, port: number, routes: Record<string, { scheme: string, header: string, secret: string, opened?: string }> },
 *   theme?: { colors?: { dark?: Record<string, string>, light?: Record<string, string> } },
 *   app: { root: boolean },
 *   term: { keep_hours: number, max?: number, shell?: string },
 *   projects?: { move?: "enabled" } }} Config
 * owner.id: the person's public, non-secret 16-byte id (hex), for the phone's avatar (team-lead,
 * 28 Sep) -- see ownerId()/fingerprint8() below. projects.move "enabled" lets projects.move
 * really move a box's homes (off until box-deploy validates it).
 * app.root: on by default, the one app (ADR 0027) answers "/" and /app/* is a 301 to the same path
 * under "/", so an installed /app/ Home Screen icon or a stale bookmark still opens (core/daemon/index.js
 * route()). Off, the app is served at /app/ only; there is no other web app to answer "/".
 * `role` is the machine's old two-value job (box or local): its meaning and default (an OS guess)
 * are unchanged, so the many modules that still read `ctx.config.role` directly need no change.
 * `machine` is the person's actual choice (ADR 0039): solo, server or device -- module loading
 * (roleBuckets, core/modules/index.js), presence and onboard read this one, not `role`. */

/**
 * Pages on other sites that may call this box from the owner's browser: Vyre's hosted app. Config
 * network.origins replaces the list; an empty list turns cross-origin calls off.
 */
export const HOSTED_ORIGINS = Object.freeze(["https://app.vyre.run"]);

/** The origins in effect for this network config, lowercased, no trailing slash. @param {any} network @returns {string[]} */
export function hostedOrigins(network) {
  const list = network && Array.isArray(network.origins) ? network.origins : HOSTED_ORIGINS;
  return list.map(o => String(o).toLowerCase().replace(/\/+$/, ""));
}

/**
 * The box's work folder: the vyre-work volume, which Taildrive shares. Tests point
 * VYRE_WORK_DIR at a temp folder.
 */
export function workDir() {
  return path.resolve(untilde(process.env.VYRE_WORK_DIR || "/work"));
}

/**
 * Where projects lived before the box kept them in the work folder: ~/Vyre/projects, which on the
 * box is inside the vyre-home volume with the vault and Claude's sign-in, and is never shared.
 * Tests point VYRE_OLD_PROJECTS_DIR at a temp folder.
 */
export function oldProjectsDir() {
  return path.resolve(untilde(process.env.VYRE_OLD_PROJECTS_DIR || path.join(os.homedir(), "Vyre", "projects")));
}

/** The record projects.move writes in the vyre home (core/projects/move.js RECORD). */
export const MOVED_RECORD = "projects-moved.json";

/**
 * The projects folder a box uses when config.json names none: inside the work folder, when there
 * is one and the box is new or its homes were moved (load() decides).
 */
export function boxProjectsDir() {
  return path.join(workDir(), "projects");
}

/**
 * Defaults: one person on one machine, nothing enabled that needs setting up. `platform` is
 * injectable (default `process.platform`) so a test can cover the darwin branch on any CI
 * machine, the way `core/names/tailscale.js`'s `installCommand` already does.
 * @param {string} root @param {string} [platform]
 */
/** On a box with accounts (each session's own uid and HOME), each account's Claude transcripts, expanded when read. */
function accountTranscripts() {
  const home = process.env.VYRE_ACCOUNTS_HOME || "/home/acct";
  try { return fs.statSync(home).isDirectory() ? [path.join(home, "*", ".claude", "projects")] : []; } catch { return []; }
}

function defaults(root, platform = process.platform) {
  const claude = claudeHome(root);
  return {
    // A fresh install on a Mac or a Windows PC is someone's own device; only a bare Linux install
    // defaults to being the server.
    role: platform === "darwin" || platform === "win32" ? "local" : "box",
    // The person's explicit choice (ADR 0039), defaulted the same way `role` always was until
    // they say otherwise: alone on a Mac is Solo, and stays exactly today's local role (no
    // box-only module, no server-side presence) until they choose "server" themselves; a
    // provisioned box is already a server, since there was never a solo mode for one. Reviewer's
    // HOLD on 80fd866e: a first pass made solo BOTH a server and a device, which put the eight
    // box-only modules on every existing Mac with no choice made -- fixed in isServer(), above.
    machine: platform === "darwin" ? "solo" : platform === "win32" ? "device" : "server",
    projectsDir: path.join(os.homedir(), "Vyre", "projects"),
    roots: [],
    me: { domains: [], emails: [] },
    // synced: sessions a paired device sent here with the person's consent (ADR 0008, amendment).
    transcripts: [path.join(claude, "projects"), path.join(claude, "projects-archive"), path.join(root, "synced"), ...accountTranscripts()],
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
    // On: the one app answers "/" (ADR 0027; core/daemon/app.js); a person may turn it off.
    app: { root: true },
    term: { keep_hours: 12 },
  };
}

/**
 * The user's settings, merged over the defaults. A missing or unreadable file is not an error:
 * a fresh install has none, and a broken one should not stop vyred from starting, so it is
 * reported through `problems` and the defaults are used.
 * @param {string} [root] @param {string} [platform] injectable for tests; see defaults().
 * @returns {Config & { problems: string[] }}
 */
export function load(root = home(), platform = process.platform) {
  const p = paths(root);
  const problems = [];
  let user = {};
  try { user = JSON.parse(fs.readFileSync(p.config, "utf8")); }
  catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") problems.push("config.json unreadable: " + /** @type {Error} */ (e).message); }
  const d = defaults(root, platform);
  const c = {
    ...d, ...user,
    me: { ...d.me, ...(user.me || {}) },
    modules: { ...d.modules, ...(user.modules || {}) },
    network: { ...d.network, ...(user.network || {}) },
    glass: { ...d.glass, ...(user.glass || {}), egress: { ...d.glass.egress, ...((user.glass && user.glass.egress) || {}) } },
    computers: { ...d.computers, ...(user.computers || {}), tailnet: { ...d.computers.tailnet, ...((user.computers && user.computers.tailnet) || {}) } },
    hooks: { ...d.hooks, ...(user.hooks || {}) },
    app: { ...d.app, ...(user.app || {}) },
    term: { ...d.term, ...(user.term || {}) },
  };
  if (!["box", "local"].includes(c.role)) { problems.push(`role "${c.role}" is not box or local; using ${d.role}`); c.role = d.role; }
  // machine (ADR 0039) is new and additive: an old config.json naming a role but no machine
  // gets one inferred from that explicit choice, which says more than the OS guess in
  // defaults() would -- someone who set role: "box" by hand meant a real server, not Solo.
  if (user.machine === undefined && user.role !== undefined) c.machine = user.role === "box" ? "server" : user.role === "local" ? "solo" : c.machine;
  if (!["solo", "server", "device"].includes(c.machine)) { problems.push(`machine "${c.machine}" is not solo, server or device; using ${d.machine}`); c.machine = d.machine; }
  // On a box with a work folder, projects live there so Taildrive can share them, but only where
  // nothing has to move: a new box (no homes in ~/Vyre/projects), or one whose homes the owner
  // already moved with projects.move (the record is there). An existing box keeps
  // ~/Vyre/projects until then. The role may come from config.json, so this is decided here
  // rather than in defaults(). A projectsDir the user set always wins.
  if (user.projectsDir === undefined && c.role === "box" && isDir(workDir())
    && (isEmpty(oldProjectsDir()) || fs.existsSync(path.join(root, MOVED_RECORD)))) c.projectsDir = boxProjectsDir();
  c.projectsDir = untilde(c.projectsDir);
  c.roots = (c.roots || []).map(untilde);
  c.transcripts = (c.transcripts || []).map(untilde);
  return { ...c, problems };
}

const isDir = (/** @type {string} */ p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** A folder that is missing, or holds nothing. Anything unreadable counts as full, so nothing is decided on a guess. */
const isEmpty = (/** @type {string} */ p) => {
  try { return fs.readdirSync(p).length === 0; }
  catch (e) { return /** @type {any} */ (e).code === "ENOENT"; }
};

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
  ownerOnly(p.root);
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

/**
 * The person's public, non-secret id: 16 random bytes, hex. Made once -- during onboarding (the
 * first time anything reads it, which for a fresh install is right away) or, for an install that
 * predates this field, on the first read after an upgrade -- and never changed after. Only
 * core/onboard's own startup ever calls this with `root`/`live` to persist a fresh one; every
 * other reader gets whatever is already there, or null before anything has run since the upgrade
 * (system.info's own "owner.name" already works this way).
 * @param {any} cfg @param {string} [root] @param {any} [live]
 */
export function ownerId(cfg, root, live) {
  if (cfg.owner && cfg.owner.id) return cfg.owner.id;
  if (!root) return null;
  const id = crypto.randomBytes(16).toString("hex");
  save({ owner: { id } }, root, live);
  return id;
}

/**
 * What a surface may show before anyone is proven present: not the id itself (an unguessable
 * secret's worth of entropy, kept out of logs and screens on principle even though it isn't a
 * credential), but a short, stable fingerprint of it -- the same base64url string every time, for
 * this person, everywhere (a phone matching its own scan against the box it is pairing to). One
 * encoding everywhere: base64url, the same as the relay's pairing ticket. The formula itself
 * lives in lib/identity.js, the one place both sides of a pairing (this and tailnet's relay)
 * compute and encode it, so they can never drift apart.
 *
 * owner.id is display identity only, never a trust anchor -- see lib/identity.js.
 * @param {string} id
 */
export function fingerprint8(id) {
  return toBase64url(fingerprint8Bytes(id, "person"));
}

/** Create the data folders if they are missing. Safe to call every start. */
export function ensure(root = home()) {
  const p = paths(root);
  for (const dir of [p.root, p.vault, p.modules, p.watchers, p.logs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // win32: mode bits do nothing, so the ACL is set on the home; everything inside inherits it.
  ownerOnly(p.root);
  // POSIX: the socket's own shared folder is mode-checked before anything binds inside it, never
  // after: vyred's listener runs later, in core/daemon/index.js. Nothing to do on win32: a named
  // pipe (socketPath's win32 branch) has no filesystem folder to create or protect.
  if (process.platform !== "win32" && path.dirname(p.socket) !== p.root) privateSocketDir();
  return p;
}
