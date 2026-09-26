// @ts-check
// drive: the box's chosen folders on the paired Mac, through Taildrive.
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
//     passes the files guard and holds none of Vyre's own private places;
//   - only the owner shares or unshares: the box's terminal, the Capsule, or a paired Mac, never
//     an agent;
//   - files.drive.audit asks tailscaled, for every online peer, which drive capability the policy
//     gives it here, and reports any node holding one that is not a paired Mac.
//
// What a share exposes is the whole folder. The files guard's per-file rules (no .env, no keys)
// hold for Vyre's own tools, but WebDAV serves every file under the shared folder to whoever the
// policy lets in. That is why the audit exists, and why a share is audited as soon as it is made.
//
// On the Mac, mount, unmount and open go through seams, so no test ever mounts a volume or opens
// a Finder window.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { run as tailscale } from "../names/tailscale.js";

/**
 * Test seams, keyed by the VYRE_HOME a registry runs with: { mount(url, dir, opts), unmount(dir),
 * open(target), mounts(), home }. Anything left out uses the real thing, which refuses to run
 * under node --test.
 * @type {Map<string, { mount?: Function, unmount?: Function, open?: Function, mounts?: () => Promise<string[]>, home?: string }>}
 */
export const seams = new Map();

/** Taildrive's WebDAV server, answered by the Mac's own Tailscale. */
export const QUAD100 = "http://100.100.100.100:8080";
export const DRIVE_CAP = "tailscale.com/cap/drive";

/** Where to read how to turn Taildrive on. The steps are in the tailnet policy, which Vyre never edits. */
const FIX_SHARE = "In the Tailscale admin console, Access controls: give this box the drive:share node attribute, give the Mac drive:access, and grant tailscale.com/cap/drive from your Mac to the box (see https://tailscale.com/kb/1369/taildrive).";
const FIX_ACCESS = "In the Tailscale admin console, Access controls: give this Mac the drive:access node attribute and grant tailscale.com/cap/drive from it to the box (see https://tailscale.com/kb/1369/taildrive).";

/** A share name Tailscale keeps as written: lowercase letters, digits, dash and underscore. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Callers of vyred's own socket that are the owner: the terminal and the Capsule. */
const OWNER_SOCKET = new Set(["cli", "local", "capsule"]);

/** Does this caller name an agent ("mcp:agent:kit", "harness:agent:kit")? The same test as glass's. */
const isAgent = caller => /(?:^|[\s:])agent:/.test(String(caller || ""));

/** Mounting and opening can raise a dialog or a window: never under tests unless a person asks (core/vault/mac/dialogs.js). */
const livesAllowed = (env = process.env) => env.VYRE_NO_DIALOGS !== "1" && (!env.NODE_TEST_CONTEXT || env.VYRE_TEST_DIALOGS === "1");

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const real = p => { try { return fs.realpathSync(p); } catch { return null; } };
const refuse = (message, code = "denied") => Object.assign(new Error(message), { code });

/**
 * Pure: the shares this box offers, name to absolute path. Defaults first, then config
 * files.drive.shares over them; a name set to null removes a default.
 *   projects     config projectsDir when it sits inside a files root, else the first files root
 *                (on the box that is /work, which compose names Projects);
 *   glass-files  the first of glass.roots, when Glass has box folders at all.
 * @param {any} config the loaded config @param {string[]} roots the files roots, resolved
 * @returns {Record<string, string>}
 */
export function shareMap(config, roots) {
  /** @type {Record<string, string>} */
  const out = {};
  const pd = config && typeof config.projectsDir === "string" ? path.resolve(config.projectsDir) : null;
  const projects = pd && roots.some(r => inside(pd, path.resolve(r))) ? pd : roots[0];
  if (projects) out.projects = path.resolve(projects);
  const glassRoots = config && config.glass && Array.isArray(config.glass.roots) ? config.glass.roots : [];
  const g = glassRoots.find(d => typeof d === "string" && path.isAbsolute(d));
  if (g) out["glass-files"] = path.resolve(g);
  const given = config && config.files && config.files.drive && config.files.drive.shares;
  if (given && typeof given === "object" && !Array.isArray(given)) {
    for (const [name, p] of Object.entries(given)) {
      if (p === null) delete out[name];
      else if (typeof p === "string" && NAME.test(name)) out[name] = p;
    }
  }
  return out;
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
  if (r.code === 127) throw refuse("Tailscale is not installed here", "no_tailscale");
  try { return JSON.parse(r.out); } catch { throw refuse((r.err || r.out).trim().split("\n")[0] || "tailscale status failed", "no_tailscale"); }
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

/** @returns {Promise<string>} */
function exec(cmd, args) {
  if (!livesAllowed()) return Promise.reject(refuse("mounting and opening are off under tests", "off_in_tests"));
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30_000 }, (e, out, err) => {
    if (e) reject(new Error(String(err || e.message).trim().split("\n")[0]));
    else resolve(String(out));
  }));
}

/**
 * Register the drive tools for this machine's role.
 * @param {any} ctx the files module's context
 * @param {{ role: "box"|"local", guard: any, roots: string[] }} opts
 */
export function drive(ctx, { role, guard: g, roots }) {
  const cfg = (ctx.config && ctx.config.files && ctx.config.files.drive) || {};
  const access = cfg.access === "rw" ? "rw" : "ro";
  const seam = seams.get(ctx.paths.root) || {};
  const fx = { ...SYSTEM, ...seam };
  const nameInput = { type: "object", required: ["name"], properties: { name: { type: "string" } } };

  if (role === "box") return boxSide();
  return macSide();

  function boxSide() {
    const shares = () => shareMap(ctx.config, roots);

    /** The stable IDs of the paired Macs, from the link module's table. None when link is not running. */
    const paired = () => {
      try { return new Set(ctx.store.db.prepare("SELECT stable_id FROM link_peers WHERE stable_id IS NOT NULL").all().map(r => String(/** @type {any} */ (r).stable_id))); }
      catch { return new Set(); }
    };

    /** Share and unshare are the owner's: the box's terminal, the Capsule, or a paired Mac. Never an agent. */
    const owner = meta => {
      const caller = String(meta && meta.caller);
      if ((meta && meta.agent) || isAgent(caller)) throw refuse("an agent cannot share or unshare the box's folders; that is for the owner");
      if (OWNER_SOCKET.has(caller)) return;
      if (caller.startsWith("tailnet:") && meta.peer && meta.peer.stableId && paired().has(String(meta.peer.stableId))) return;
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
      if (privateHere.some(x => inside(/** @type {string} */ (x), safe.path) || inside(/** @type {string} */ (x), safe.real))) throw refuse("not available", "not_available");
      return safe.real;
    };

    const known = name => {
      const map = shares();
      if (!NAME.test(name) || !Object.prototype.hasOwnProperty.call(map, name)) {
        throw refuse(`no share called "${name}"; the box offers ${Object.keys(map).join(", ") || "none"} (config files.drive.shares)`, "unknown_share");
      }
      return map[name];
    };

    async function driveStatus() {
      const st = await status();
      const map = shares();
      const configured = Object.entries(map).map(([name, p]) => ({ name, path: p }));
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
      if (findings.length) ctx.events.emit("drive.exposed", { findings });
      return { ok: findings.length === 0, findings, checked: peers.length };
    }

    ctx.tool("files.drive.status", {
      description: "Whether this box may share folders over Taildrive, the shares it offers (config files.drive.shares), and what is shared now.",
      input: { type: "object", properties: {} },
      run: driveStatus,
    });

    ctx.tool("files.drive.share", {
      description: "Share one of the box's offered folders with the paired Mac over Taildrive. Owner only. Audits who else the tailnet policy lets in, right after.",
      input: nameInput,
      run: async ({ name }, meta) => {
        owner(meta);
        const p = known(name);
        const st = await status();
        if (!hasCap(st, "drive:share")) throw Object.assign(refuse("the tailnet policy does not let this box share folders (no drive:share node attribute)", "drive_off"), { detail: { fix: FIX_SHARE } });
        const where = folder(p);
        const r = await tailscale(["drive", "share", name, where]);
        if (r.code !== 0) throw refuse((r.err || r.out).trim().split("\n")[0] || "tailscale drive share failed", "failed");
        return { shared: name, path: where, access, audit: await audit() };
      },
    });

    ctx.tool("files.drive.unshare", {
      description: "Stop sharing one of the box's folders over Taildrive. Owner only.",
      input: nameInput,
      run: async ({ name }, meta) => {
        owner(meta);
        known(name);
        const r = await tailscale(["drive", "unshare", name]);
        if (r.code !== 0) throw refuse((r.err || r.out).trim().split("\n")[0] || "tailscale drive unshare failed", "failed");
        return { unshared: name };
      },
    });

    ctx.tool("files.drive.audit", {
      description: "Check the tailnet policy from the box's side: every online node the policy lets into Taildrive here that is not a paired Mac is a finding.",
      input: { type: "object", properties: {} },
      run: audit,
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
    const dirOf = share => {
      if (!NAME.test(String(share))) throw refuse(`"${share}" is not a share name`, "bad_input");
      return path.join(base, share);
    };
    const isMounted = async dir => { try { return (await fx.mounts()).map(String).includes(dir); } catch { return false; } };

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
      if (!node) throw refuse("this Mac is not paired with a box (vyre link pair <address>)", "no_link");
      const st = await status();
      return { ...driveUrl(st, node, share), ...(hasCap(st, "drive:access") ? { ready: true } : { ready: false, fix: FIX_ACCESS }) };
    }

    // The box's side, asked from the Mac. Share and unshare stay the owner's here too: the box
    // trusts this paired Mac, so the Mac must not pass on an agent's request.
    ctx.tool("files.drive.status", {
      description: "The box's Taildrive state (asked over the link), and what this Mac has mounted.",
      input: { type: "object", properties: {} },
      run: async () => {
        const box = await forward("files.drive.status", {});
        const mounted = load();
        const shares = await Promise.all((box && Array.isArray(box.shares) ? box.shares : []).map(async s => {
          const dir = path.join(base, String(s.name));
          return { ...s, mounted: Boolean(mounted[s.name]) && await isMounted(dir), dir };
        }));
        return { ...box, shares, source: "box" };
      },
    });
    for (const [tool, what] of [["files.drive.share", "Share one of the box's folders with this Mac over Taildrive."], ["files.drive.unshare", "Stop sharing one of the box's folders."]]) {
      ctx.tool(tool, { description: what, input: nameInput, callers: ["cli", "local", "capsule"], run: ({ name }) => forward(tool, { name }) });
    }
    ctx.tool("files.drive.audit", {
      description: "Ask the box which nodes the tailnet policy lets into its Taildrive shares, besides this Mac.",
      input: { type: "object", properties: {} },
      run: () => forward("files.drive.audit", {}),
    });

    ctx.tool("files.drive.url", {
      description: "The WebDAV address of one of the box's Taildrive shares, as this Mac reaches it.",
      input: { type: "object", required: ["share"], properties: { share: { type: "string" } } },
      run: ({ share }) => url(share),
    });

    ctx.tool("files.drive.mount", {
      description: "Mount one of the box's shared folders at ~/Vyre/Box/<share>, so Finder and the Capsule open box files where they are.",
      input: { type: "object", required: ["share"], properties: { share: { type: "string" } } },
      callers: ["cli", "local", "capsule"],
      run: async ({ share }) => {
        const dir = dirOf(share);
        const box = await forward("files.drive.status", {});
        const s = box && Array.isArray(box.shares) ? box.shares.find(x => x.name === share) : null;
        if (!s) throw refuse(`the box offers no share called "${share}"`, "unknown_share");
        if (!s.shared) throw refuse(`the box is not sharing "${share}"; share it first (files.drive.share)`, "not_shared");
        const u = await url(share);
        if (!u.ready) throw Object.assign(refuse("the tailnet policy does not let this Mac use Taildrive (no drive:access node attribute)", "drive_off"), { detail: { fix: FIX_ACCESS } });
        const readonly = box.access !== "rw";
        if (!(await isMounted(dir))) {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
        if (!(await isMounted(dir))) throw refuse(`"${share}" is not mounted on this Mac; mount it first (files.drive.mount)`, "not_mounted");
        const r = String(rel || "");
        if (r.includes("\0") || path.isAbsolute(r) || r.split(/[\\/]+/).includes("..")) throw refuse("path must be relative to the share, with no ..", "bad_input");
        const target = path.join(dir, r);
        if (!inside(target, dir)) throw refuse("path must be inside the share", "bad_input");
        await fx.open(target);
        return { opened: target };
      },
    });

    ctx.tool("files.drive.local", {
      description: "Where a box file is on this Mac through a mounted Taildrive share, or null when no mounted share holds it.",
      input: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      run: async ({ path: p }) => {
        const want = String(p);
        if (!path.posix.isAbsolute(want) || want.includes("\0") || want.split("/").includes("..")) return { local: null };
        const m = load();
        for (const [share, rec] of Object.entries(m)) {
          const bp = String(rec && rec.boxPath || "");
          if (!bp || !inside(want, bp)) continue;
          if (!(await isMounted(String(rec.dir)))) continue;
          const local = path.join(String(rec.dir), path.posix.relative(bp, want));
          if (inside(local, String(rec.dir))) return { local, share };
        }
        return { local: null };
      },
    });
  }
}
