// @ts-check
// picker: choosing what VyreDrive shares, without typing a path (box side).
//
// files.drive.candidates lists what could be shared: the projects first, then the folders inside
// the files roots. files.drive.measure says how big one folder is and whether it may be shared
// at all (the same guard and secret scan sharing itself runs). files.drive.offer turns a chosen
// folder into a share and shares it, in one step, so the person never edits config.
//
// There is no exclusion list on purpose. Taildrive serves a whole folder, so hiding a subfolder
// from a share is not something Vyre can do: leaving a folder "out" in a picker would be a
// promise the transport does not keep. The way to share less is to share the smaller folder, and
// measure says how much is in each. Generated folders (node_modules, dist and the like) are
// listed by name and left out of the counts, exactly as the secret scan leaves them out.

import fs from "node:fs";
import path from "node:path";
import * as config from "../config/index.js";
import { reach, within, withinReal } from "./access.js";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const refuse = (message, code = "denied") => Object.assign(new Error(message), { code });
const MAX_CANDIDATES = 200;

/** Pure: a share name Tailscale keeps, from a project slug or a folder name. Null when nothing usable is left. */
export function shareNameFor(text) {
  const n = String(text || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 64);
  return NAME.test(n) ? n : null;
}

/**
 * @param {any} ctx
 * @param {{ g: any, roots: string[], folder: (p: string) => string, scan: (dir: string) => { found: string[], tooBig: boolean, seen: number },
 *   specs: () => Record<string, { path: string, access: "ro"|"rw" }>, shares: () => Record<string, string>,
 *   owner: (meta: any) => void, shareOne: (name: string) => Promise<any>, limit: number, skip: Set<string> }} d
 */
export function picker(ctx, { g, roots, folder, scan, specs, shares, owner, shareOne, limit, skip }) {
  const real = p => { try { return fs.realpathSync(p); } catch { return null; } };

  /** Folder p as the picker would offer it: its guarded path, or null when sharing it could never work. */
  const usable = p => { try { g.resolveSafe(p); folder(p); return g.resolveSafe(p).path; } catch { return null; } };

  const sharedAs = p => {
    const r = real(p);
    return Object.entries(shares()).find(([, sp]) => sp === p || (r && real(sp) === r))?.[0] || null;
  };

  /** A scoped caller may look only inside its own granted folders; the owner sees all. */
  async function scopeOf(meta) {
    const s = await reach(ctx, meta && meta.caller, meta);
    return { ...s, may: p => s.all || (within(p, s.folders) && withinReal(p, s.folders)) };
  }

  ctx.tool("files.drive.candidates", {
    description: "Folders this box could share over VyreDrive, projects first, then folders in its file roots, each marked with its share. Feed one to files.drive.measure.",
    input: { type: "object", properties: {} },
    run: async (input, meta = {}) => {
      const scope = await scopeOf(meta);
      /** @type {any[]} */
      const projects = [];
      const seen = new Set();
      try {
        const r = await ctx.call("projects.list", {});
        for (const p of (r && r.data && r.data.projects) || []) {
          const home = typeof p.home === "string" ? p.home : "";
          const at = home && usable(home);
          if (!at || seen.has(at) || !scope.may(at)) continue;
          seen.add(at);
          projects.push({ kind: "project", slug: String(p.slug), name: String(p.name || p.slug), path: at, shared: sharedAs(at), suggestedName: shareNameFor(p.slug) });
        }
      } catch { /* no projects module: the folders below still work */ }
      /** @type {any[]} */
      const folders = [];
      for (const root of roots) {
        let ents = [];
        try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!e.isDirectory() || e.name.startsWith(".") || skip.has(e.name) || !g.nameAllowed(e.name)) continue;
          const at = usable(path.join(root, e.name));
          if (!at || seen.has(at) || !scope.may(at)) continue;
          seen.add(at);
          folders.push({ kind: "folder", name: e.name, path: at, shared: sharedAs(at), suggestedName: shareNameFor(e.name) });
        }
      }
      return { candidates: [...projects, ...folders].slice(0, MAX_CANDIDATES), projects: projects.length };
    },
  });

  /**
   * Count what a share of this folder would serve. Generated folders are named, not counted; a
   * link is counted as a link, never followed.
   * @param {string} dir
   */
  function count(dir) {
    let files = 0, folders = 0, bytes = 0, partial = false;
    const generated = new Set();
    const stack = [dir];
    while (stack.length) {
      const d = /** @type {string} */ (stack.pop());
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.isDirectory() && (skip.has(e.name) || (path.basename(d) === ".git" && e.name === "objects"))) { if (skip.has(e.name)) generated.add(e.name); continue; }
        if (files + folders >= limit) { partial = true; return { files, folders, bytes, generated: [...generated].sort(), partial }; }
        const p = path.join(d, e.name);
        if (e.isDirectory()) { folders++; stack.push(p); continue; }
        files++;
        try { bytes += fs.lstatSync(p).size; } catch { /* gone between the read and the stat */ }
      }
    }
    return { files, folders, bytes, generated: [...generated].sort(), partial };
  }

  /** Measure one folder for the picker: size, what is left out of the count, and whether it may be shared. */
  const measure = p => {
    let dir;
    try { dir = folder(p); } catch (e) { return { path: String(p), shareable: false, why: /** @type {Error} */ (e).message }; }
    const at = g.resolveSafe(p).path;
    const c = count(dir);
    const s = scan(dir);
    const why = s.tooBig ? `more than ${limit} files and folders, too many to check for secrets; pick a smaller folder`
      : s.found.length ? `has secrets inside (${s.found.slice(0, 3).join(", ")}${s.found.length > 3 ? ", ..." : ""}); move them out or pick a folder without them` : null;
    return { path: at, ...c, findings: s.found, tooBig: s.tooBig, shareable: !why, ...(why ? { why } : {}), shared: sharedAs(at), suggestedName: shareNameFor(path.basename(at)) };
  };

  ctx.tool("files.drive.measure", {
    description: "How big a folder is (files, folders, bytes) and whether VyreDrive may share it; a folder with a .env or key is not shareable.",
    input: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    run: async ({ path: p }, meta = {}) => {
      p = String(p || "");
      if (!p || p.includes("\0")) throw refuse("path is required", "bad_input");
      const scope = await scopeOf(meta);
      if (!scope.may(p)) return { path: p, shareable: false, why: "not available" };
      return measure(p);
    },
  });

  ctx.tool("files.drive.offer", {
    description: "Share a folder you picked over VyreDrive in one step: checks it like files.drive.measure, adds it to the box's shares under a name (a project's own name by default) and shares it. Read-only unless access is rw. Owner only. Nothing is added if the folder is refused.",
    input: { type: "object", required: ["path"], properties: { path: { type: "string" }, name: { type: "string" }, access: { type: "string", enum: ["ro", "rw"] } } },
    run: async ({ path: p, name, access = "ro" }, meta) => {
      owner(meta);
      p = String(p || "");
      if (!p || p.includes("\0")) throw refuse("path is required", "bad_input");
      if (access !== "ro" && access !== "rw") throw refuse('access is "ro" or "rw"', "bad_input");
      const at = usable(p);
      if (!at) folder(p); // throws the real reason
      const m = measure(p);
      if (!m.shareable) throw Object.assign(refuse(`"${path.basename(String(at))}" ${m.why}`, "unsafe_share"), { detail: { found: m.findings || [] } });
      const share = name === undefined ? m.suggestedName : String(name);
      if (!share || !NAME.test(share)) throw refuse("give the share a name of lowercase letters, digits, dash or underscore", "bad_input");
      const map = shares();
      const existing = Object.prototype.hasOwnProperty.call(map, share) ? map[share] : null;
      if (existing && existing !== at && real(existing) !== real(String(at))) throw refuse(`a share called "${share}" already offers another folder; pick another name`, "name_taken");
      const drv = (ctx.config.files && ctx.config.files.drive) || {};
      const given = drv.shares && typeof drv.shares === "object" && !Array.isArray(drv.shares) ? drv.shares : {};
      config.save({ files: { drive: { ...drv, shares: { ...given, [share]: { path: at, access } } } } }, ctx.paths.root, ctx.config);
      try {
        return { ...(await shareOne(share)), name: share, note: "Checked for secrets now. One added to this folder later is not scanned until the next audit." };
      } catch (e) {
        config.save({ files: { drive: { ...drv, shares: given } } }, ctx.paths.root, ctx.config);
        throw e;
      }
    },
  });
}
