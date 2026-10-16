// @ts-check
// drive: the box's offered folders ("shares"), read through Vyre's own tools.
//
// A share is a folder the box offers by name (config files.drive.shares, plus the project and Glass defaults). Vyre reads inside one with plain calls, all under the files guard
// (no secret, no dot folder, no link leading out) and a named agent's own granted projects: files.drive.status (what is offered), files.drive.search (a name across the shares),
// files.drive.list and files.drive.read (browse.js), the # tag for a file (mentions.js), and the project's Generated folder. Nothing here runs another product's program, serves a
// folder to another machine or mounts one: the mounted share this module used to make was removed, and mounted box files come back later on a different design.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reach, within } from "./access.js";
import { createDoor } from "../../lib/gateway-door.js";
import { classify, KINDS } from "./kinds.js";
import { walk as searchWalk, defaults as searchDefaults } from "./search.js";
import { browse } from "./browse.js";
import { mentions } from "./mentions.js";
import { filesMigrations } from "./migrations.js";

/** A share name: lowercase letters, digits, dash and underscore. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
 * The box's offered folders and the tools that read them. On a computer (role local) the same tools ask the box.
 * @param {any} ctx @param {{ role: string, guard: any, roots: string[] }} d
 */
export function drive(ctx, { role, guard: g, roots }) {
  if (role === "box") return boxSide();
  return macSide();

  function boxSide() {
    const specs = () => shareSpecs(ctx.config, roots);
    const shares = () => shareMap(ctx.config, roots);

    /**
     * A share's folder, checked. It must pass the files guard (inside a files root, no secret or dot name on the way), be a folder, and hold none of Vyre's private places:
     * a folder with ~/.vyre or the home folder inside it is never offered.
     */
    const folder = p => {
      const safe = g.resolveSafe(p);
      if (!fs.statSync(safe.real).isDirectory()) throw refuse("a share must be a folder", "bad_input");
      const privateHere = [ctx.paths.root, ctx.paths.vault, os.homedir()].filter(Boolean)
        .flatMap(x => [path.resolve(String(x)), real(String(x))]).filter(Boolean);
      if (privateHere.some(x => inside(/** @type {string} */ (x), safe.path) || inside(/** @type {string} */ (x), safe.real))) throw refuse("not available (files.drive.status lists the shares on offer)", "not_available");
      return safe.real;
    };

    const spaceDriveState = async (/** @type {any} */ meta) => {
      try {
        const d = await createDoor(ctx).open({}, meta);
        if (!d.gateway.drive) return { enabled: false, why: "this Space has no Drive yet" };
        try { const r = await d.gateway.drive.listPage(d.chain, "", { limit: 1000 }); return { enabled: true, files: r.entries.length, more: r.next !== null }; }
        catch (e) { return { enabled: true, readable: false, why: "you may not list this Drive" }; }
      } catch (e) { return { enabled: null, why: "the Drive's state is for a signed-in person" }; }
    };

    ctx.tool("files.drive.status", {
      description: "The box's offered folders: each share's name and access, and the state of the Space's own Drive. A named agent sees only the shares inside its own granted projects.",
      input: { type: "object", properties: {} },
      run: async (input, meta = {}) => {
        const configured = Object.entries(specs()).map(([name, s]) => ({ name, path: s.path, access: s.access }));
        const st = { shares: configured, space: await spaceDriveState(meta) };
        const scope = await reach(ctx, meta && meta.caller, meta);
        if (scope.all) return st;
        const mine = p => within(p, scope.folders);
        return { ...st, shares: st.shares.filter(s => mine(s.path)) };
      },
    });

    ctx.store.migrate(filesMigrations());
    /** @type {{ tagged: Function }} */
    const box = { tagged: () => null };
    const { resolve: resolveIn } = browse(ctx, { g, folder, shares, tagged: (t, s, r) => box.tagged(t, s, r) });
    box.tagged = mentions(ctx, { store: ctx.store, folder, shares, resolveIn }).tagged;

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
          // same domain scope.folders itself lives in - a project's granted folder is never
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
    /** Ask the box, and turn its failure into a readable error with the box's code. */
    const forward = async (tool, input) => {
      const r = await ctx.remote(tool, input);
      if (r && r.error) throw Object.assign(new Error(r.error.message || "the box is not reachable"), { code: r.error.code || "box_unreachable", ...(r.error.detail ? { detail: r.error.detail } : {}) });
      return r && r.data;
    };
    ctx.tool("files.drive.status", {
      callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module"],
      description: "The box's offered folders, asked from this computer over the link.",
      input: { type: "object", properties: {} },
      run: async () => ({ ...(await forward("files.drive.status", {})), source: "box" }),
    });
    // The # tag for files lives on the box (where chats run); the computer only passes a search along.
    ctx.tool("files.mentions.search", {
      description: "Files on the box's shares whose name matches what you typed after #, for tagging one in a chat. Runs as the person asking.",
      input: { type: "object", properties: { q: { type: "string" }, limit: { type: "integer" } } },
      callers: ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "agent"],
      run: input => forward("files.mentions.search", input),
    });
    ctx.tool("files.mentions.resolve", {
      description: "Make a tagged file readable in the chat it was tagged in. The box does this; a computer has no chats of its own.",
      input: { type: "object", required: ["id", "thread"], properties: { id: { type: "string" }, thread: { type: "string" }, said: { type: "string" } } },
      callers: ["module"],
      run: async () => { throw refuse("that file is not available; use the box, where a tag is resolved in the chat it was tagged in", "not_found"); },
    });
    ctx.tool("files.drive.search", {
      description: "Find files by name or content across the box's offered shares, asked from this computer (the search behind Lumen's find-a-file). An agent's identity does not survive the hop to the box, so a named agent is refused.",
      input: { type: "object", required: ["q"], properties: {
        q: { type: "string" }, limit: { type: "integer" }, share: { type: "string" },
        kinds: { type: "array", items: { type: "string" } } } },
      run: async (input, meta = {}) => {
        const scope = await reach(ctx, meta && meta.caller, meta);
        if (!scope.all) throw refuse("an agent searches this computer's own files only, not the box directly; use files.search", "denied");
        return forward("files.drive.search", input);
      },
    });
  }
}
