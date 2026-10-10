// @ts-check
// drive: VyreDrive (Taildrive underneath), the box's chosen folders on the paired Mac.
//
// Taildrive is Tailscale's own file sharing: tailscaled on the box serves a folder over WebDAV,
// and the Mac reaches it at http://100.100.100.100:8080/<tailnet>/<machine>/<share>, which its
// own Tailscale answers. So Finder and the Capsule open box files where they are, with no copy
// in between and no port of vyred's in the path.
//
// Who may reach a share is decided by the tailnet policy, not here: the box needs the
// "drive:share" node attribute, the Mac "drive:access", and a grant carrying the
// tailscale.com/cap/drive capability from the owner to the box. Vyre never edits that policy.
// It does three things instead:
//   - it shares only the folders named in config files.drive.shares, and only when the folder
//     passes the files guard, holds none of Vyre's own private places, and has nothing the guard
//     calls a secret anywhere inside it (a .env, a key, a password store);
//   - only the owner shares or unshares: the box's terminal, the Capsule, or a paired Mac, never
//     an agent;
//   - files.drive.audit asks tailscaled, for every online peer, which drive capability the policy
//     gives it here, and reports any node holding one that is not a paired Mac.
//
// What a share exposes is the whole folder. The files guard's per-file rules (no .env, no keys)
// hold for Vyre's own tools, but WebDAV serves every file under the shared folder to whoever the
// policy lets in. That is why a share's tree is scanned before it is shared and again at every
// audit, and why a share is audited as soon as it is made.
//
// Each share is read-only unless its own access says "rw" (files.drive.access, the owner's own
// action: no proof, but never an agent, a model or a guest). The tailscale container's /work mount has to be rw too for writes to land; vyred
// cannot change that, so it answers the .env step instead.
//
// On the Mac, mount, unmount and open go through seams, so no test ever mounts a volume or opens
// a Finder window.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { tailscaleBin } from "../link/transport.js";
/**
 * Legacy: sharing a folder as a disk still drives another product's drive sharing when its program is on the machine, and answers "not installed" (code 127) when it is not
 * (every test, and every Vyre server: none ships it). Its replacement, VyreDrive's loopback mount, is not built yet (team/BACKLOG.md); this file's callers go with it.
 * @param {string[]} args @param {{ timeout?: number }} [opts] @returns {Promise<{ code: number, out: string, err: string }>}
 */
const tailscale = (args, { timeout = 15_000 } = {}) => {
  const b = tailscaleBin();
  if (!b) return Promise.resolve({ code: 127, out: "", err: "not installed" });
  return new Promise(resolve => {
    execFile(b, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => {
      const code = !e ? 0 : /** @type {any} */ (e).code === "ENOENT" ? 127 : Number(/** @type {any} */ (e).code) || 1;
      resolve({ code, out: String(out), err: String(err) });
    });
  });
};
import * as config from "../config/index.js";
import { looksLikeKey, secretName, HOME_DENIED } from "./safety.js";
import { reach, within } from "./access.js";
import { createDoor } from "../../lib/gateway-door.js";
import { classify, KINDS } from "./kinds.js";
import { walk as searchWalk, defaults as searchDefaults } from "./search.js";
import { picker } from "./picker.js";
import { browse } from "./browse.js";
import { mentions, MIGRATIONS as MENTION_MIGRATIONS } from "./mentions.js";
import { uncFor, mapArgs, unmapArgs, parseNetUse, freeLetter, explainNetUse } from "./drive-windows.js";

/**
 * Test seams, keyed by the VYRE_HOME a registry runs with: { mount(url, dir, opts), unmount(dir),
 * open(target), mounts(), home }. Anything left out uses the real thing, which refuses to run
 * under node --test.
 * @type {Map<string, { mount?: Function, unmount?: Function, open?: Function, mounts?: () => Promise<string[]>, letter?: () => Promise<string|null>, platform?: string, home?: string }>}
 */
export const seams = new Map();

/** Taildrive's WebDAV server, answered by the Mac's own Tailscale. */
export const QUAD100 = "http://100.100.100.100:8080";
export const DRIVE_CAP = "tailscale.com/cap/drive";

/** Where to read how to turn VyreDrive on (Taildrive underneath). The steps are in the tailnet policy, which Vyre never edits. */
const FIX_SHARE = "In the Tailscale admin console, Access controls: give this box the drive:share node attribute, give the Mac drive:access, and grant tailscale.com/cap/drive from your Mac to the box (see https://tailscale.com/kb/1369/taildrive).";
const FIX_ACCESS = "In the Tailscale admin console, Access controls: give this Mac the drive:access node attribute and grant tailscale.com/cap/drive from it to the box (see https://tailscale.com/kb/1369/taildrive).";

/** A share name Tailscale keeps as written: lowercase letters, digits, dash and underscore. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Callers of vyred's own socket that are the owner: the terminal and the Capsule. */
const OWNER_SOCKET = new Set(["cli", "local", "capsule"]);
/** The person's own surfaces and Vyre's modules: for a tool that reports on the tailnet or the box without the asker's identity surviving the hop, so no model is meant to call it. */
const PERSON_AND_MODULE = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module"];

/** Does this caller name an agent ("mcp:agent:kit", "harness:agent:kit")? The same test as glass's. */
const isAgent = caller => /(?:^|[\s:])agent:/.test(String(caller || ""));

/** Mounting and opening can raise a dialog or a window: never under tests unless a person asks (core/vault/mac/dialogs.js). */
const livesAllowed = (env = process.env) => env.VYRE_NO_DIALOGS !== "1" && (!env.NODE_TEST_CONTEXT || env.VYRE_TEST_DIALOGS === "1");

/** How many entries a share's scan looks at before it gives up and refuses. */
export const SCAN_LIMIT = 20_000;

/**
 * Folders a share's scan does not walk: dependencies and build output, large and generated. Only
 * real folders; .git/objects is skipped too (in walk), the rest of .git is scanned.
 */
export const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "target", "venv", ".venv"]);

/** How much of a .git/config the scan reads. */
const GIT_CONFIG_MAX = 64 * 1024;

/**
 * Pure: does this git config text hold a credential? A URL with a user or token before the host
 * (https://x-access-token:abc@github.com/...), or an extraheader carrying Authorization. An ssh
 * URL's user alone (ssh://git@github.com) is a login name, not a secret, so it is not counted.
 * @param {string} text
 */
export function gitConfigCredential(text) {
  for (const m of String(text).matchAll(/([a-z][a-z0-9+.-]*):\/\/([^\s\/@"']+)@[^\s\/@"']/gi)) {
    const scheme = m[1].toLowerCase(), user = m[2];
    if (/ssh/.test(scheme) && !user.includes(":")) continue;
    return true;
  }
  return /^\s*extraheader\s*=.*\bauthorization\b/im.test(String(text));
}

/** Read the first GIT_CONFIG_MAX bytes of a .git/config and look for a credential. */
function gitCredential(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(GIT_CONFIG_MAX);
    const n = fs.readSync(fd, buf, 0, GIT_CONFIG_MAX, 0);
    return gitConfigCredential(buf.subarray(0, n).toString("utf8"));
  } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** The .env step for the tailscale container's /work mount. */
export const mountStep = mode => `Set VYRE_DRIVE_ACCESS=${mode} in /srv/vyre/.env, then run docker compose up -d`;

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
const refuse = (message, code = "denied") => Object.assign(new Error(message), { code });

/**
 * Pure: the shares this box offers, name to { path, access }. Defaults first, then config
 * files.drive.shares over them; a name set to null removes a default.
 *   projects     config projectsDir when it sits inside a files root, else the first files root
 *                (on the box that is /work, which compose names Projects);
 *   glass-files  the first of glass.roots, when Glass has box folders at all.
 * An entry is a path, or { path, access }; { access } alone keeps a default's path. Access is
 * "ro" unless it says "rw". A share that does not say takes the old global files.drive.access,
 * so a config written before shares had their own access mounts as it did.
 * @param {any} config the loaded config @param {string[]} roots the files roots, resolved
 * @returns {Record<string, { path: string, access: "ro"|"rw" }>}
 */
export function shareSpecs(config, roots) {
  const drv = (config && config.files && config.files.drive) || {};
  /** @type {"ro"|"rw"} */
  const fallback = drv.access === "rw" ? "rw" : "ro";
  /** @type {Record<string, { path: string, access: "ro"|"rw" }>} */
  const out = {};
  const pd = config && typeof config.projectsDir === "string" ? path.resolve(config.projectsDir) : null;
  const projects = pd && roots.some(r => inside(pd, path.resolve(r))) ? pd : roots[0];
  if (projects) out.projects = { path: path.resolve(projects), access: fallback };
  const glassRoots = config && config.glass && Array.isArray(config.glass.roots) ? config.glass.roots : [];
  const g = glassRoots.find(d => typeof d === "string" && path.isAbsolute(d));
  if (g) out["glass-files"] = { path: path.resolve(g), access: fallback };
  const given = drv.shares;
  if (given && typeof given === "object" && !Array.isArray(given)) {
    for (const [name, v] of Object.entries(given)) {
      if (v === null) { delete out[name]; continue; }
      if (!NAME.test(name)) continue;
      if (typeof v === "string") out[name] = { path: v, access: fallback };
      else if (v && typeof v === "object") {
        const p = typeof v.path === "string" ? v.path : out[name] && out[name].path;
        const access = v.access === "rw" ? "rw" : v.access === "ro" ? "ro" : fallback;
        if (p) out[name] = { path: p, access };
      }
    }
  }
  return out;
}

/** Pure: the shares this box offers, name to absolute path (shareSpecs without access). */
export function shareMap(config, roots) {
  return Object.fromEntries(Object.entries(shareSpecs(config, roots)).map(([n, s]) => [n, s.path]));
}

/**
 * Pure: `tailscale drive list`, which prints a table
 *   name        path          as
 *   --------    ----------    ----
 *   projects    /work         vyre
 * The dash row gives each column's width, so a path with spaces in it still parses.
 * @param {string} out @returns {{ name: string, path: string, as: string }[]}
 */
export function parseDriveList(out) {
  const lines = String(out || "").split("\n");
  const d = lines.findIndex(l => /^-+(\s+-+)+\s*$/.test(l));
  if (d < 0) return [];
  /** @type {[number, number][]} */
  const cols = [];
  const re = /-+/g;
  let m;
  while ((m = re.exec(lines[d]))) cols.push([m.index, m.index + m[0].length]);
  const cell = (l, i) => l.slice(cols[i][0], i + 1 < cols.length ? cols[i + 1][0] : undefined).trim();
  return lines.slice(d + 1).filter(l => l.trim()).map(l => ({ name: cell(l, 0), path: cols.length > 1 ? cell(l, 1) : "", as: cols.length > 2 ? cell(l, 2) : "" }));
}

/**
 * Pure: the drive capability a `tailscale whois --json` answer says the policy grants that peer
 * on this node, or null. The values are the grant's app entries, e.g. [{ shares: ["*"], access: "rw" }].
 * @returns {{ shares: string[], access: "ro"|"rw" } | null}
 */
export function driveCap(w) {
  const caps = w && w.CapMap && w.CapMap[DRIVE_CAP];
  if (!caps) return null;
  const list = Array.isArray(caps) ? caps : [];
  const shares = [...new Set(list.flatMap(c => (c && Array.isArray(c.shares) ? c.shares.map(String) : [])))];
  // Tailscale reads an access it does not recognise as read-only; "rw" anywhere means writes.
  const access = list.some(c => c && String(c.access).toLowerCase() === "rw") ? "rw" : "ro";
  return { shares, access };
}

/**
 * Pure: the WebDAV address of a share on the box, from the Mac's `tailscale status --json`.
 *
 * Source for the path: Tailscale's Taildrive docs (https://tailscale.com/kb/1369/taildrive) give
 * http://100.100.100.100:8080/<tailnet>/<machine>/<share>. In tailscaled (ipn/ipnlocal/drive.go)
 * the first segment is the netmap's Domain, which is what status reports as CurrentTailnet.Name,
 * and each machine is the peer's display name, the first label of its MagicDNS name. So
 * CurrentTailnet.Name comes first, MagicDNSSuffix only when it is missing, and the DNS label
 * before HostName, which is the machine's own OS name and can differ from its tailnet name.
 * @param {any} st status JSON @param {string} boxNode the box's MagicDNS name, from link.status
 * @param {string} share
 */
export function driveUrl(st, boxNode, share) {
  const tailnet = String((st && st.CurrentTailnet && st.CurrentTailnet.Name) || (st && st.MagicDNSSuffix) || "").replace(/\.$/, "");
  if (!tailnet) throw new Error("Tailscale on this Mac does not say which tailnet it is on; is it signed in?");
  const node = String(boxNode || "").replace(/\.$/, "");
  const peers = Object.values((st && st.Peer) || {});
  const peer = /** @type {any} */ (peers.find(p => p && String(p.DNSName || "").replace(/\.$/, "") === node));
  const machine = (peer && String(peer.DNSName || "").split(".")[0]) || (peer && peer.HostName) || node.split(".")[0];
  if (!machine) throw new Error("this Mac does not know the box's machine name; pair with the box first");
  const url = `${QUAD100}/${[tailnet, machine, share].map(encodeURIComponent).join("/")}`;
  return { url, tailnet, machine, share };
}

/** Parse `tailscale status --json`, or throw a readable error. */
async function status() {
  const r = await tailscale(["status", "--json"]);
  if (r.code === 127) throw refuse("sharing folders to a computer as a disk is not available on this device yet; the Space's own Drive and VyreDrive transfers do not need it", "unavailable");
  try { return JSON.parse(r.out); } catch { throw refuse("sharing folders to a computer as a disk could not start here; make sure Tailscale is running and signed in, then try again", "unavailable"); }
}

const hasCap = (st, cap) => Boolean(st && st.Self && st.Self.CapMap && Object.prototype.hasOwnProperty.call(st.Self.CapMap, cap));

/** Default seams: the real macOS commands. Each refuses under tests, so a missing fake never mounts. */
const SYSTEM = {
  /** mount_webdav, not `osascript mount volume`: it runs unprivileged into a folder this user owns, takes no dialog with -S, and needs no Automation permission. */
  mount: (url, dir, { readonly, name }) => exec("/sbin/mount_webdav", ["-S", "-v", name, ...(readonly ? ["-o", "rdonly"] : []), url, dir]),
  unmount: dir => exec("/sbin/umount", [dir]),
  open: target => exec("/usr/bin/open", [target]),
  /** Mounted folders, from mount(8): "<source> on <dir> (<type>, ...)". */
  mounts: async () => {
    const out = await exec("/sbin/mount", []);
    return out.split("\n").map(l => / on (.+) \(([^,)]+)/.exec(l)).filter(Boolean).map(m => /** @type {RegExpExecArray} */ (m)[1]);
  },
};

/**
 * The Windows commands: net use maps the share as a drive letter (drive-windows.js), and Explorer
 * opens it. Explorer answers exit code 1 even when it worked, so its exit is ignored.
 */
/** A drive letter and nothing else: a `*` from a state file would unmap every drive. */
const letterOk = l => { if (!/^[A-Z]:$/.test(String(l))) throw refuse("not a drive letter", "bad_input"); };
const SYSTEM_WIN = {
  letter: async () => freeLetter(parseNetUse(await exec("net.exe", ["use"])).used),
  mount: async (url, letter) => { letterOk(letter); try { await exec("net.exe", mapArgs(letter, uncFor(url))); } catch (e) { throw new Error(explainNetUse(/** @type {Error} */ (e).message)); } },
  unmount: letter => { letterOk(letter); return exec("net.exe", unmapArgs(letter)); },
  open: target => exec("explorer.exe", [target], true),
  mounts: async () => parseNetUse(await exec("net.exe", ["use"])).vyre.map(x => x.letter),
};

/** @returns {Promise<string>} */
function exec(cmd, args, ignoreExit = false) {
  if (!livesAllowed()) return Promise.reject(refuse("mounting and opening are off under tests", "off_in_tests"));
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (e, out, err) => {
    if (e && !ignoreExit) reject(new Error(String(err || out || e.message).trim().split(/\r?\n/)[0]));
    else resolve(String(out));
  }));
}

/**
 * Register the drive tools for this machine's role.
 * @param {any} ctx the files module's context
 * @param {{ role: "box"|"local", guard: any, roots: string[] }} opts
 */
export function drive(ctx, { role, guard: g, roots }) {
  const seam = seams.get(ctx.paths.root) || {};
  const win = (seam.platform || process.platform) === "win32";
  const fx = { ...(win ? SYSTEM_WIN : SYSTEM), ...seam };
  const nameInput = { type: "object", required: ["name"], properties: { name: { type: "string" } } };

  if (role === "box") return boxSide();
  return macSide();

  function boxSide() {
    const specs = () => shareSpecs(ctx.config, roots);
    const shares = () => shareMap(ctx.config, roots);
    /** "rw" when any share is, since the container's mount has to allow the widest. */
    const overall = () => (Object.values(specs()).some(s => s.access === "rw") ? "rw" : "ro");

    /** The stable IDs of the paired Macs, from the link module's table. None when link is not running. */
    const paired = () => {
      try { return new Set(ctx.store.db.prepare("SELECT stable_id FROM link_peers WHERE stable_id IS NOT NULL").all().map(r => String(/** @type {any} */ (r).stable_id))); }
      catch { return new Set(); }
    };

    /** Share and unshare are the owner's: the box's terminal, the Capsule, or a paired Mac. Never an agent. */
    /** Is the kernel's chain for this call exactly one person (never a label)? A build with no kernel (development) takes the daemon's verified person-session fact: SHIM(legacy labels). */
    const personCall = async meta => {
      if (!ctx.kernel || typeof ctx.kernel.chain !== "function") return Boolean(meta && meta.person);
      try { const c = await ctx.kernel.chain(meta); return Boolean(c && Array.isArray(c.hops) && c.hops.length === 1 && c.hops[0].actor && c.hops[0].actor.kind === "person"); } catch { return false; }
    };
    const owner = async meta => {
      const caller = String(meta && meta.caller);
      if ((meta && meta.agent) || isAgent(caller)) throw refuse("an agent cannot share or unshare the box's folders; that is for the owner");
      if (OWNER_SOCKET.has(caller)) return;
      // A paired Mac: its own paired peer id AND the kernel's chain saying the call is the person's. What the caller's label looks like decides nothing.
      if (meta && meta.peer && meta.peer.stableId && paired().has(String(meta.peer.stableId)) && await personCall(meta)) return;
      throw refuse("only the owner shares the box's folders: from the box's terminal, the Capsule or a paired Mac");
    };

    /**
     * A share's folder, checked. It must pass the files guard (inside a files root, no secret or
     * dot name on the way), be a folder, and hold none of Vyre's private places: the whole tree is
     * served, so a folder with ~/.vyre or the home folder inside it is never shared.
     */
    const folder = p => {
      const safe = g.resolveSafe(p);
      if (!fs.statSync(safe.real).isDirectory()) throw refuse("a share must be a folder", "bad_input");
      const privateHere = [ctx.paths.root, ctx.paths.vault, os.homedir()].filter(Boolean)
        .flatMap(x => [path.resolve(String(x)), real(String(x))]).filter(Boolean);
      if (privateHere.some(x => inside(/** @type {string} */ (x), safe.path) || inside(/** @type {string} */ (x), safe.real))) throw refuse("not available (files.drive.candidates lists the folders that may be shared)", "not_available");
      return safe.real;
    };

    const known = name => {
      const map = shares();
      if (!NAME.test(name) || !Object.prototype.hasOwnProperty.call(map, name)) {
        throw refuse(`no share called "${name}"; the box offers ${Object.keys(map).join(", ") || "none"} (config files.drive.shares)`, "unknown_share");
      }
      return map[name];
    };

    /**
     * Everything inside a share's folder that the files guard calls a secret: a .env file, a key
     * by name or by its first bytes, a password store, a denied place such as the vault or an
     * .ssh folder, and a link to any of those. The guard hides dot folders like .git from Vyre's
     * own tools, but they are not secrets, so they are scanned and not refused; a .git/config
     * that holds a credential (a remote URL with a user or token before the host, or an
     * extraheader with an Authorization value) is a finding. Build and dependency folders
     * (SKIP_DIRS) and .git/objects are not walked and do not count toward SCAN_LIMIT: they are
     * large, generated, and hold no hand-placed secret. Only real folders are skipped; a link
     * with one of those names is still checked as a link. A folder that cannot be read is a
     * finding: nothing says it is safe. Stops at 10 findings, and after SCAN_LIMIT entries says
     * the tree is too big to check.
     * @param {string} dir a folder that passed folder() @returns {{ found: string[], tooBig: boolean, seen: number }}
     */
    const scan = dir => {
      const r = walk(dir);
      return { ...r, found: r.found.sort() };
    };
    /** @param {string} dir @returns {{ found: string[], tooBig: boolean, seen: number }} */
    const walk = dir => {
      const found = [];
      let seen = 0;
      const homeDenied = HOME_DENIED.map(d => path.sep + d);
      const secret = p => secretName(path.basename(p)) || g.isDenied(p) || homeDenied.some(d => p.endsWith(d));
      const stack = [dir];
      while (stack.length) {
        const d = /** @type {string} */ (stack.pop());
        let ents;
        try { ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
        catch { found.push(path.relative(dir, d) || "."); if (found.length >= 10) break; continue; }
        const dirs = [];
        const inGit = path.basename(d) === ".git";
        for (const e of ents) {
          // Real folders only: withFileTypes says isDirectory() false for a link.
          if (e.isDirectory() && (SKIP_DIRS.has(e.name) || (inGit && e.name === "objects"))) continue;
          if (++seen > SCAN_LIMIT) return { found, tooBig: true, seen };
          const p = path.join(d, e.name);
          let bad = secret(p);
          if (!bad && e.isFile()) bad = looksLikeKey(p) || (inGit && e.name === "config" && gitCredential(p));
          else if (!bad && e.isSymbolicLink()) {
            const r = real(p);
            bad = Boolean(r && (secret(r) || looksLikeKey(r, [e.name, path.basename(r)])));
          } else if (!bad && e.isDirectory()) dirs.push(p);
          if (bad) { found.push(path.relative(dir, p)); if (found.length >= 10) return { found, tooBig: false, seen }; }
        }
        stack.push(...dirs.reverse());
      }
      return { found, tooBig: false, seen };
    };

    /** Refuse a folder with a secret inside, or one too big to check. */
    const clean = (name, dir) => {
      const r = scan(dir);
      if (r.tooBig) throw Object.assign(refuse(`"${name}" holds more than ${SCAN_LIMIT} files and folders, too many to check for secrets; share a smaller folder`, "unsafe_share"), { detail: { found: r.found, tooBig: true } });
      if (r.found.length) throw Object.assign(refuse(`"${name}" has secrets inside (${r.found.slice(0, 3).join(", ")}${r.found.length > 3 ? ", ..." : ""}); move them out or share a folder without them`, "unsafe_share"), { detail: { found: r.found } });
    };

    /** Does the tailscale container's mount have to change? vyred sees VYRE_DRIVE_ACCESS only when compose passes it. */
    const mountState = () => {
      const want = overall();
      const env = process.env.VYRE_DRIVE_ACCESS;
      const now = env === "rw" ? "rw" : env === "ro" ? "ro" : "unknown";
      return { want, now, change: now !== want, ...(now !== want ? { step: mountStep(want) } : {}) };
    };

    async function driveStatus() {
      const configured = Object.entries(specs()).map(([name, s]) => ({ name, path: s.path, access: s.access }));
      const access = overall();
      // Nothing in 0.3 depends on Tailscale: a box with none still answers, with the shared folders off (`tailnet: false`) and no error. The Space's own Drive does not use it.
      let st;
      try { st = await status(); } catch (e) {
        if (/** @type {any} */ (e).code !== "unavailable") throw e;
        return { enabled: false, tailnet: false, why: "this box does not mount folders as disks yet, so its folders are not shared over VyreDrive; the Space's own Drive does not need one", access,
          shares: configured.map(s => ({ ...s, shared: false })), list: [] };
      }
      if (!hasCap(st, "drive:share")) {
        return { enabled: false, why: "the tailnet policy does not let this box share folders (no drive:share node attribute)", fix: FIX_SHARE,
          access, shares: configured.map(s => ({ ...s, shared: false })), list: [] };
      }
      const r = await tailscale(["drive", "list"]);
      const list = r.code === 0 ? parseDriveList(r.out) : [];
      const on = new Set(list.map(x => x.name));
      return { enabled: true, access, shares: configured.map(s => ({ ...s, shared: on.has(s.name) })), list,
        ...(r.code !== 0 ? { error: (r.err || r.out).trim().split("\n")[0] || "tailscale drive list failed" } : {}) };
    }

    async function audit() {
      const st = await status();
      const mine = paired();
      const users = st.User || {};
      const peers = Object.values(st.Peer || {}).filter(p => p && p.Online && Array.isArray(p.TailscaleIPs) && p.TailscaleIPs.length);
      const findings = [];
      await Promise.all(peers.map(async p => {
        const r = await tailscale(["whois", "--json", String(p.TailscaleIPs[0])], { timeout: 5000 });
        if (r.code !== 0) return;
        let w;
        try { w = JSON.parse(r.out); } catch { return; }
        const cap = driveCap(w);
        if (!cap) return;
        const id = String((w.Node && w.Node.StableID) || p.ID || "");
        if (id && mine.has(id)) return;
        const login = (w.UserProfile && w.UserProfile.LoginName) || (users[String(p.UserID)] && users[String(p.UserID)].LoginName) || null;
        findings.push({ node: String((w.Node && w.Node.Name) || p.DNSName || p.HostName || "").replace(/\.$/, ""), login, access: cap });
      }));
      findings.sort((a, b) => a.node.localeCompare(b.node));
      // What is shared now, scanned again: a secret can land in a shared folder after it was shared.
      const unsafe = [];
      if (hasCap(st, "drive:share")) {
        const r = await tailscale(["drive", "list"]);
        const map = shares();
        for (const { name } of r.code === 0 ? parseDriveList(r.out) : []) {
          if (!Object.prototype.hasOwnProperty.call(map, name)) continue;
          let dir;
          try { dir = folder(map[name]); } catch { unsafe.push({ share: name, found: [], why: "the folder no longer passes the files guard" }); continue; }
          const s = scan(dir);
          if (s.tooBig) unsafe.push({ share: name, found: s.found, why: `more than ${SCAN_LIMIT} files and folders, too many to check` });
          else if (s.found.length) unsafe.push({ share: name, found: s.found });
        }
      }
      if (findings.length || unsafe.length) ctx.events.emit("drive.exposed", { findings, unsafe });
      return { ok: findings.length === 0 && unsafe.length === 0, findings, unsafe, checked: peers.length };
    }

    /** The Space's own Drive (versions, restore; no tailnet): is one wired on this home, and can the caller read the top of it? { enabled, files?, more?, why? }. Never throws. */
    const spaceDriveState = async (/** @type {any} */ meta) => {
      try {
        const d = await createDoor(ctx).open({}, meta);
        if (!d.gateway.drive) return { enabled: false, why: "this Space has no Drive yet" };
        try { const r = await d.gateway.drive.listPage(d.chain, "", { limit: 1000 }); return { enabled: true, files: r.entries.length, more: r.next !== null }; }
        catch (e) { return { enabled: true, readable: false, why: "you may not list this Drive" }; }
      } catch (e) { return { enabled: null, why: "the Drive's state is for a signed-in person" }; }
    };

    ctx.tool("files.drive.status", {
      description: "VyreDrive on the box: whether it may share folders with the paired Mac, the shares offered, and what is shared now.",
      input: { type: "object", properties: {} },
      run: async (input, meta = {}) => {
        const st = { ...(await driveStatus()), space: await spaceDriveState(meta) };
        const scope = await reach(ctx, meta && meta.caller, meta);
        if (scope.all) return st;
        const mine = p => within(p, scope.folders);
        return { ...st, shares: st.shares.filter(s => mine(s.path)), list: st.list.filter(s => mine(s.path)) };
      },
    });

    /** Share one offered name: the guard, the secret scan, tailscale drive share, then an audit. */
    const shareOne = async name => {
      const p = known(name);
      const st = await status();
      if (!hasCap(st, "drive:share")) throw Object.assign(refuse("the tailnet policy does not let this box share folders (no drive:share node attribute)", "drive_off"), { detail: { fix: FIX_SHARE } });
      const where = folder(p);
      clean(name, where);
      const r = await tailscale(["drive", "share", name, where]);
      if (r.code !== 0) throw refuse((r.err || r.out).trim().split("\n")[0] || "tailscale drive share failed", "failed");
      return { shared: name, path: where, access: specs()[name].access, audit: await audit() };
    };

    ctx.tool("files.drive.address", {
      description: "Where one of this box's VyreDrive shares is reached on the tailnet, for a device that has no Vyre of its own to ask (a Windows PC's Vyre app): the WebDAV address, the Windows network path for it, the share's access, and whether the box is sharing it now. The owner and the owner's own devices only.",
      input: { type: "object", required: ["share"], properties: { share: { type: "string" } } },
      run: async ({ share }, meta = {}) => {
        if (!(await reach(ctx, meta && meta.caller, meta)).all) throw refuse("only the owner's own devices ask where a share is", "denied");
        known(String(share));
        const st = await status();
        const node = st && st.Self && String(st.Self.DNSName || "").replace(/\.$/, "");
        if (!node) throw refuse("this box has no address for a mounted share yet; use the Space's Drive in the app", "unavailable");
        const a = driveUrl(st, node, String(share));
        const list = hasCap(st, "drive:share") ? await tailscale(["drive", "list"]) : null;
        const shared = Boolean(list && list.code === 0 && parseDriveList(list.out).some(x => x.name === share));
        return { ...a, unc: uncFor(a.url), access: specs()[String(share)].access, shared };
      },
    });

    ctx.tool("files.drive.share", {
      description: "Share one of the box's offered folders with the paired Mac over VyreDrive. Owner only. Audits who else the tailnet policy lets in, right after.",
      input: nameInput,
      run: async ({ name }, meta) => {
        await owner(meta);
        return shareOne(name);
      },
    });

    ctx.store.migrate(MENTION_MIGRATIONS);
    /** @type {{ tagged: Function }} */
    const box = { tagged: () => null };
    const { resolve: resolveIn } = browse(ctx, { g, folder, shares, tagged: (t, s, r) => box.tagged(t, s, r) });
    box.tagged = mentions(ctx, { store: ctx.store, folder, shares, resolveIn }).tagged;
    picker(ctx, { g, roots, folder, scan, specs, shares, owner, shareOne, limit: SCAN_LIMIT, skip: SKIP_DIRS });

    ctx.tool("files.drive.access", {
      description: "Make one of the box's shares read-only (ro) or read-write (rw) for the paired Mac. Owner only, with no proof asked; never an agent, a model or a guest. Says when the tailscale container's /work mount must change to match.",
      input: { type: "object", required: ["name", "mode"], properties: { name: { type: "string" }, mode: { type: "string", enum: ["ro", "rw"] } } },
      run: async ({ name, mode }, meta) => {
        await owner(meta);
        known(name);
        if (mode !== "ro" && mode !== "rw") throw refuse('mode is "ro" or "rw"', "bad_input");
        const drv = (ctx.config.files && ctx.config.files.drive) || {};
        const given = drv.shares && typeof drv.shares === "object" && !Array.isArray(drv.shares) ? drv.shares : {};
        const cur = given[name];
        // A default share keeps its default path: only the access is written.
        const entry = typeof cur === "string" ? { path: cur, access: mode } : { ...(cur && typeof cur === "object" ? cur : {}), access: mode };
        config.save({ files: { drive: { ...drv, shares: { ...given, [name]: entry } } } }, ctx.paths.root, ctx.config);
        return { name, access: specs()[name].access, mount: mountState() };
      },
    });

    ctx.tool("files.drive.unshare", {
      description: "Stop sharing one of the box's folders over VyreDrive. Owner only.",
      input: nameInput,
      run: async ({ name }, meta) => {
        await owner(meta);
        known(name);
        const r = await tailscale(["drive", "unshare", name]);
        if (r.code !== 0) throw refuse((r.err || r.out).trim().split("\n")[0] || "tailscale drive unshare failed", "failed");
        return { unshared: name };
      },
    });

    ctx.tool("files.drive.audit", {
      // The box sees who asks: a named agent is refused in the body (reach), a bare session is the person's own Claude and is not.
      callers: [...PERSON_AND_MODULE, "mcp", "harness"],
      description: "Check the tailnet policy from the box: any online node besides a paired Mac that can reach the VyreDrive shares is a finding. Owner only.",
      input: { type: "object", properties: {} },
      run: async (input, meta = {}) => {
        if (!(await reach(ctx, meta && meta.caller, meta)).all) throw refuse("an agent cannot audit VyreDrive's tailnet policy; that is for the owner");
        return audit();
      },
    });

    /**
     * A path already known to sit inside a share's real folder, checked and described the same
     * way files/index.js's own describe() does (same guard, same key-content refusal), without
     * requiring the path to fall under one of the box's configured files.roots: a share may name
     * any folder (shareSpecs), and search must cover it regardless.
     * @param {string} shareReal @param {string} p
     */
    const describeInShare = (shareReal, p) => {
      const rs = { live: [{ given: shareReal, real: shareReal }] };
      const safe = g.resolveSafe(p, rs);
      const st = fs.statSync(safe.real);
      const name = path.basename(safe.path);
      const { kind, mime } = classify(name, st.isDirectory());
      return { path: safe.path, name, kind, mime, size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString() };
    };

    ctx.tool("files.drive.search", {
      description: "Find files by name or content across the box's offered VyreDrive shares. A named agent searches only shares inside its granted projects.",
      input: { type: "object", required: ["q"], properties: {
        q: { type: "string" }, limit: { type: "integer" }, share: { type: "string", description: "search only this share" },
        kinds: { type: "array", items: { type: "string", enum: KINDS } } } },
      run: async ({ q, limit = 50, share, kinds }, meta = {}) => {
        q = String(q || "").trim();
        if (!q) throw refuse("q is required", "bad_input");
        limit = Math.min(500, Math.max(1, Number(limit) || 50));
        kinds = kinds && kinds.length ? kinds : undefined;
        const scope = await reach(ctx, meta && meta.caller, meta);
        const map = shares();
        let names = Object.keys(map);
        if (share) {
          if (!Object.prototype.hasOwnProperty.call(map, share)) {
            // Reviewer M1: an agent never learns the box's other share names from a typo or a
            // probe. The owner still gets the helpful list; a scoped caller gets the same bare
            // "unknown" an ungranted-but-real share would also produce below.
            throw refuse(scope.all ? `no share called "${share}"; the box offers ${names.join(", ") || "none"}` : `no share called "${share}"`, "unknown_share");
          }
          names = [share];
        }
        // Same rule as files.drive.status: an unrestricted caller sees every offered share; a
        // named agent sees only the ones its own granted projects reach, either direction (a
        // share nested inside a granted project, or a share that itself contains one).
        if (!scope.all) names = names.filter(n => within(map[n], scope.folders) || scope.folders.some(f => within(f, [map[n]])));
        const want = limit * 4 + 100;
        const notes = [];
        const results = [];
        for (const name of names) {
          if (results.length >= limit) break;
          let shareReal;
          try { shareReal = folder(map[name]); } catch { continue; } // must still pass the same check sharing does
          // Reviewer H1: a share can be broader than what a named agent is granted (a share of
          // /work with a grant of only /work/harlow-site). Walking and rg'ing the share's whole
          // real folder in that case would hand the agent file names, and through rg a content
          // oracle, for every sibling project under the same share. So for a restricted scope,
          // narrow to the actual intersection: each granted folder that falls inside this share
          // (the narrower side), or the whole share when it instead falls inside a granted
          // folder (already covered end to end, same as today). An unrestricted caller keeps
          // searching the whole share, as before.
          //
          // Compared against the share's own configured (not yet realpath-resolved) path, the
          // same domain scope.folders itself lives in — a project's granted folder is never
          // realpath-resolved either, so comparing against shareReal directly could miss a match
          // behind a symlinked temp dir. Each winning raw folder is then resolved the same way
          // folder() resolved the share itself (the module-level real(), not this loop's own
          // shareReal), so what actually gets walked is real.
          const rawShare = map[name];
          const dirs = scope.all ? [shareReal] : [...new Set(scope.folders
            .map(f => (within(f, [rawShare]) ? f : within(rawShare, [f]) ? rawShare : null))
            .filter(Boolean)
            .map(d => real(d) || d))];
          if (!dirs.length) continue;
          let candidates = [];
          try { candidates = searchWalk(dirs, q, g, { max: want }); } catch { continue; }
          try {
            candidates.push(...await searchDefaults.rg(["-l", "-i", "-F", "--max-count", "1", "--max-filesize", "2M", "--", q, ...dirs], { max: want }));
          } catch (e) {
            if (/** @type {any} */ (e).code === "ENOENT" && !notes.includes("ripgrep is not installed, so only file names were matched")) notes.push("ripgrep is not installed, so only file names were matched");
          }
          const seen = new Set();
          for (const c of candidates) {
            if (results.length >= limit) break;
            if (typeof c !== "string" || seen.has(c) || c.split(path.sep).includes("node_modules")) continue;
            seen.add(c);
            let d;
            try { d = describeInShare(shareReal, c); } catch { continue; }
            if (kinds && !kinds.includes(d.kind)) continue;
            results.push({ share: name, path: d.path, name: d.name, kind: d.kind, mime: d.mime, size: d.size, mtime: d.mtime });
          }
        }
        return { results, ...(notes.length ? { note: notes.join("; ") } : {}) };
      },
    });
  }

  function macSide() {
    const home = seam.home || os.homedir();
    const base = path.join(home, "Vyre", "Box");
    const file = path.join(ctx.paths.root, "files", "drive.json");
    /** What this Mac mounted: share -> { dir, boxPath }. So a box path maps to its mounted copy without asking the box. */
    const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };
    const save = v => {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
    };
    /**
     * Where a share is (or would be) mounted. On a Mac and on Linux that is ~/Vyre/Box/<share>. On
     * Windows it is a drive letter, chosen when the share is mounted and remembered, so before
     * that there is no place yet: null.
     */
    const dirOf = share => {
      if (!NAME.test(String(share))) throw refuse(`"${share}" is not a share name`, "bad_input");
      if (win) { const rec = load()[share]; return rec && /^[A-Z]:$/.test(String(rec.dir)) ? String(rec.dir) : null; }
      return path.join(base, share);
    };
    const isMounted = async dir => { try { return Boolean(dir) && (await fx.mounts()).map(String).includes(String(dir)); } catch { return false; } };

    /** Ask the box, and turn its failure into a readable error with the box's code. */
    const forward = async (tool, input) => {
      const r = await ctx.remote(tool, input);
      if (r && r.error) throw Object.assign(new Error(r.error.message || "the box is not reachable"), { code: r.error.code || "box_unreachable", ...(r.error.detail ? { detail: r.error.detail } : {}) });
      return r && r.data;
    };

    async function url(share) {
      dirOf(share);
      const link = await ctx.call("link.status", {});
      const node = link.data && link.data.box && link.data.box.node;
      if (!node) throw refuse("this Mac is not paired with a box; pair it first (vyre link pair <address>)", "no_link");
      const st = await status();
      return { ...driveUrl(st, node, share), ...(hasCap(st, "drive:access") ? { ready: true } : { ready: false, fix: FIX_ACCESS }) };
    }

    // The box's side, asked from the Mac. Share and unshare stay the owner's here too: the box
    // trusts this paired Mac, so the Mac must not pass on an agent's request.
    ctx.tool("files.drive.status", {
      callers: PERSON_AND_MODULE,
      description: "VyreDrive (built on Tailscale's Taildrive) from the Mac: the box's shares (asked over the link), and what this Mac has mounted.",
      input: { type: "object", properties: {} },
      run: async () => {
        const box = await forward("files.drive.status", {});
        const mounted = load();
        const shares = await Promise.all((box && Array.isArray(box.shares) ? box.shares : []).map(async s => {
          const dir = win ? (mounted[s.name] && mounted[s.name].dir) || null : path.join(base, String(s.name));
          return { ...s, mounted: Boolean(mounted[s.name]) && await isMounted(dir), dir };
        }));
        return { ...box, shares, source: "box" };
      },
    });
    for (const [tool, what] of [["files.drive.share", "Share one of the box's folders with this Mac over VyreDrive."], ["files.drive.unshare", "Stop sharing one of the box's folders."]]) {
      ctx.tool(tool, { description: what, input: nameInput, callers: ["cli", "local", "capsule"], run: ({ name }) => forward(tool, { name }) });
    }
    ctx.tool("files.drive.access", {
      description: "Make one of the box's shares read-only (ro) or read-write (rw) for this Mac. Remount it after a change.",
      input: { type: "object", required: ["name", "mode"], properties: { name: { type: "string" }, mode: { type: "string", enum: ["ro", "rw"] } } },
      callers: ["cli", "local", "capsule"],
      run: ({ name, mode }) => forward("files.drive.access", { name, mode }),
    });
    ctx.tool("files.drive.audit", {
      callers: PERSON_AND_MODULE,
      description: "Ask the box which nodes the tailnet policy lets into its VyreDrive shares, besides this Mac.",
      input: { type: "object", properties: {} },
      run: () => forward("files.drive.audit", {}),
    });

    // The picker, asked from the Mac. Reads are the owner's own surfaces only here (an agent's
    // identity does not survive the hop to the box); offer is the owner's action, like share.
    for (const [tool, what] of [["files.drive.candidates", "The box's folders you could share over VyreDrive, projects first (asked over the link)."], ["files.drive.measure", "How big one of the box's folders is and whether it may be shared (asked over the link)."]]) {
      ctx.tool(tool, {
        description: what,
        input: tool === "files.drive.measure" ? { type: "object", required: ["path"], properties: { path: { type: "string" } } } : { type: "object", properties: {} },
        run: async (input, meta = {}) => {
          if (!(await reach(ctx, meta && meta.caller, meta)).all) throw refuse("an agent looks at the box's folders with files.dirs, not through the Mac", "denied");
          return forward(tool, input);
        },
      });
    }
    ctx.tool("files.drive.offer", {
      description: "Share one of the box's folders you picked over VyreDrive, by path, in one step. Owner only.",
      input: { type: "object", required: ["path"], properties: { path: { type: "string" }, name: { type: "string" }, access: { type: "string", enum: ["ro", "rw"] } } },
      callers: ["cli", "local", "capsule"],
      run: input => forward("files.drive.offer", input),
    });

    // The # tag for files lives on the box (where chats run); the Mac only passes a search along.
    ctx.tool("files.mentions.search", {
      description: "Files on the box's VyreDrive shares whose name matches what you typed after #, for tagging one in a chat. Runs as the person asking.",
      input: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" } } },
      callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent"],
      run: input => forward("files.mentions.search", input),
    });
    ctx.tool("files.mentions.resolve", {
      description: "Make a tagged file readable in the chat it was tagged in. The box does this; a Mac has no chats of its own.",
      input: { type: "object", required: ["id", "thread"], properties: { id: { type: "string" }, thread: { type: "string" }, said: { type: "string" } } },
      callers: ["module"],
      run: async () => { throw refuse("that file is not available; use the box, where a tag is resolved in the chat it was tagged in", "not_found"); },
    });

    ctx.tool("files.drive.url", {
      description: "The WebDAV address of one of the box's VyreDrive shares, as this Mac reaches it.",
      input: { type: "object", required: ["share"], properties: { share: { type: "string" } } },
      run: ({ share }) => url(share),
    });

    ctx.tool("files.drive.mount", {
      description: "Mount one of the box's shared folders at ~/Vyre/Box/<share>, so Finder and the Capsule open box files where they are.",
      input: { type: "object", required: ["share"], properties: { share: { type: "string" } } },
      callers: ["cli", "local", "capsule"],
      run: async ({ share }) => {
        let dir = dirOf(share);
        const box = await forward("files.drive.status", {});
        const s = box && Array.isArray(box.shares) ? box.shares.find(x => x.name === share) : null;
        if (!s) throw refuse(`the box offers no share called "${share}"`, "unknown_share");
        if (!s.shared) throw refuse(`the box is not sharing "${share}"; share it first (files.drive.share)`, "not_shared");
        const u = await url(share);
        if (!u.ready) throw Object.assign(refuse("the tailnet policy does not let this Mac use VyreDrive (no drive:access node attribute)", "drive_off"), { detail: { fix: FIX_ACCESS } });
        // The share's own access; a box from before shares had one sends only the top-level field.
        const readonly = (s.access || box.access) !== "rw";
        if (!(await isMounted(dir))) {
          if (win) {
            // A drive letter, not a folder. Windows' own client cannot map read-only, so the
            // share's access is enforced by the box; `readonly` still says what the box allows.
            dir = await fx.letter();
            if (!dir) throw refuse("every drive letter is in use; disconnect a drive you no longer need, then mount again", "no_letter");
          } else fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          await fx.mount(u.url, dir, { readonly, name: share });
        }
        save({ ...load(), [share]: { dir, boxPath: String(s.path), url: u.url } });
        return { share, dir, url: u.url, readonly };
      },
    });

    ctx.tool("files.drive.unmount", {
      description: "Unmount one of the box's shared folders from this Mac.",
      input: { type: "object", required: ["share"], properties: { share: { type: "string" } } },
      callers: ["cli", "local", "capsule"],
      run: async ({ share }) => {
        const dir = dirOf(share);
        const was = await isMounted(dir);
        if (was) await fx.unmount(dir);
        const m = load();
        delete m[share];
        save(m);
        return { share, unmounted: was };
      },
    });

    ctx.tool("files.drive.open", {
      description: "Open a mounted box share, or a file or folder in it, in Finder.",
      input: { type: "object", required: ["share"], properties: { share: { type: "string" }, path: { type: "string" } } },
      callers: ["cli", "local", "capsule"],
      run: async ({ share, path: rel }) => {
        const dir = dirOf(share);
        if (!(await isMounted(dir))) throw refuse(`"${share}" is not mounted on this ${win ? "PC" : "Mac"}; mount it first (files.drive.mount)`, "not_mounted");
        const r = String(rel || "");
        const P = win ? path.win32 : path;
        if (r.includes("\0") || P.isAbsolute(r) || /^[A-Za-z]:/.test(r) || r.split(/[\\/]+/).includes("..")) throw refuse("path must be relative to the share, with no ..", "bad_input");
        const top = win ? String(dir) + "\\" : String(dir);
        const target = P.join(top, r);
        const back = P.relative(top, target);
        if (back.startsWith("..") || P.isAbsolute(back)) throw refuse("path must be inside the share", "bad_input");
        await fx.open(target);
        return { opened: target };
      },
    });

    ctx.tool("files.drive.local", {
      description: "Where a box file is on this Mac through a mounted VyreDrive share, or null when no mounted share holds it. A named agent gets null for a box path outside its own granted projects, the same as any other refusal here (Vyre Drive step 5): it never learns whether a mount holds a path it may not see.",
      input: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      run: async ({ path: p }, meta = {}) => {
        const want = String(p);
        if (!path.posix.isAbsolute(want) || want.includes("\0") || want.split("/").includes("..")) return { local: null };
        const scope = await reach(ctx, meta && meta.caller, meta);
        // Reviewer H1: checking the SHARE against the grant (an overlap either direction) was
        // not enough when the share is broader than the grant (a share of /work, a grant of only
        // /work/harlow-site) — every path under that share, including a sibling project's,
        // passed. The requested path itself must sit inside the grant.
        if (!scope.all && !within(want, scope.folders)) return { local: null };
        const m = load();
        for (const [share, rec] of Object.entries(m)) {
          const bp = String(rec && rec.boxPath || "");
          if (!bp || !inside(want, bp)) continue;
          if (!(await isMounted(String(rec.dir)))) continue;
          const rel = path.posix.relative(bp, want);
          const local = win ? path.win32.join(String(rec.dir) + "\\", ...rel.split("/").filter(Boolean)) : path.join(String(rec.dir), rel);
          if (!rel.startsWith("..")) return { local, share };
        }
        return { local: null };
      },
    });

    ctx.tool("files.drive.search", {
      description: "Find files by name or content across the box's offered VyreDrive shares, asked from this Mac (the search behind the Capsule's find-a-file and the Windows panel). An agent's identity does not survive the hop to the box (see files.search's own note on this), so this is the owner's own surfaces only for now; an agent searches this Mac's own files.search instead.",
      input: { type: "object", required: ["q"], properties: {
        q: { type: "string" }, limit: { type: "integer" }, share: { type: "string" },
        kinds: { type: "array", items: { type: "string" } } } },
      run: async (input, meta = {}) => {
        const scope = await reach(ctx, meta && meta.caller, meta);
        if (!scope.all) throw refuse("an agent searches this Mac's own files only, not the box directly; use files.search", "denied");
        return forward("files.drive.search", input);
      },
    });
  }
}
