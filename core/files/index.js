// @ts-check
// files — find, look at and bring over files, on this machine and across the link to the box.
//
// The same module runs on both machines. On the box it answers for the box's folders (default
// /work). On the Mac it answers for the Mac's folders (default the home folder, searched with
// Spotlight) and, for anything on the box, asks the files module there through ctx.remote. So a
// search from the Mac can show both machines at once, and a file on the box can be previewed or
// pulled down without anyone opening a terminal on it.
//
// What may be seen is decided in one place, safety.js. This file never touches a path the
// guard has not passed, and search results go through the same guard as direct requests, so
// Spotlight or ripgrep can never hand back something the guard would refuse.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { guard } from "./safety.js";
import { classify, KINDS } from "./kinds.js";
import { defaults, walk } from "./search.js";
import { drop } from "./drop.js";

const run = promisify(execFile);
const KIB = 1024, MIB = 1024 * KIB, GIB = 1024 * MIB;
const CHUNK = MIB;
const PREVIEW = 64 * KIB, PREVIEW_CAP = 256 * KIB;
const SMALL_IMAGE = 512 * KIB;

/**
 * Test seams, keyed by the VYRE_HOME a registry runs with: { mdfind, rg, platform, thumbnail,
 * remoteTimeout }. Anything left out uses the real thing. Keyed by home so tests running side
 * by side never see each other's fakes.
 * @type {Map<string, { mdfind?: Function, rg?: Function, platform?: string, thumbnail?: Function, remoteTimeout?: number }>}
 */
export const seams = new Map();

/**
 * Interleave this machine's results with the box's, one each in turn, so neither machine's
 * results push the other's off the end of a short list. Capped at limit.
 * @template T @param {T[]} local @param {T[]} box @param {number} limit @returns {T[]}
 */
export function merge(local, box, limit) {
  const out = [];
  for (let i = 0; out.length < limit && (i < local.length || i < box.length); i++) {
    if (i < local.length) out.push(local[i]);
    if (i < box.length && out.length < limit) out.push(box[i]);
  }
  return out;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hasNul = buf => buf.includes(0);

/** Only the fields a search result is meant to carry, whatever a remote sent. */
const tidy = (r, source) => ({ source, path: String(r.path), name: String(r.name), kind: String(r.kind),
  size: Number(r.size) || 0, mtime: r.mtime });

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const cfg = (ctx.config && ctx.config.files) || {};
    const role = ctx.config.role === "box" ? "box" : "local";
    const here = role === "local" ? "mac" : "box";
    const seam = seams.get(ctx.paths.root) || {};
    const platform = seam.platform || process.platform;
    const mdfind = seam.mdfind || defaults.mdfind;
    const rg = seam.rg || defaults.rg;
    const remoteTimeout = seam.remoteTimeout || 4000;
    const roots = Array.isArray(cfg.roots) && cfg.roots.length ? cfg.roots.map(String) : role === "box" ? ["/work"] : [os.homedir()];
    const maxFetch = Number.isFinite(cfg.maxFetch) && cfg.maxFetch > 0 ? cfg.maxFetch : GIB;
    const g = guard({ roots, allowDot: Array.isArray(cfg.allowDot) ? cfg.allowDot : [], vyreHome: ctx.paths.root, vault: ctx.paths.vault });

    /** Where a request is meant for: this machine, or the box through the link. */
    function target(source) {
      if (!source || source === here) return "here";
      if (role === "local" && source === "box") return "box";
      throw new Error("the box cannot reach files on the Mac");
    }

    /** Ask the box's files module, and turn its failure into a readable error. */
    async function forward(tool, input) {
      const r = await ctx.remote(tool, input);
      if (r && r.error) {
        const e = r.error;
        // A refusal or a bad request on the box is the box's answer, passed on as it is. Only a
        // link problem gets reworded, with its code, so a surface can say "the box is offline".
        const link = ["box_unreachable", "no_link", "unreachable", "timeout", "not_box"].includes(e.code);
        throw Object.assign(new Error(link ? `the box is not reachable (${e.code})` : e.message), { code: link ? "box_unreachable" : e.code });
      }
      return { ...(r && r.data), source: "box" };
    }

    /** A checked path with what stat and the name say about it. */
    function describe(p, rs) {
      const safe = g.resolveSafe(p, rs);
      const st = fs.statSync(safe.real);
      const name = path.basename(safe.path);
      const { kind, mime } = classify(name, st.isDirectory());
      return { path: safe.path, real: safe.real, name, kind, mime, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size,
        mtime: st.mtime.toISOString() };
    }

    /** Search this machine only. Never throws: a failure is reported in its source entry. */
    async function searchHere(q, limit, kinds) {
      const rs = g.roots();
      const notes = [];
      if (rs.missing.length) notes.push(`skipped folders that do not exist: ${rs.missing.join(", ")}`);
      // Ask the backends for more than the limit: some candidates will be filtered out.
      const want = limit * 4 + 100;
      let candidates = [];
      try {
        if (role === "local" && platform === "darwin") {
          // Spotlight matches names and contents, and already knows every file, so it is fast.
          const lists = await Promise.all(rs.live.map(r => mdfind(["-onlyin", r.real, q], { max: want })));
          candidates = lists.flat();
        } else {
          if (role === "local") notes.push("Spotlight is not available here, so the folders were walked");
          candidates = walk(rs.live.map(r => r.real), q, g, { max: want });
          if (rs.live.length) {
            try {
              candidates.push(...await rg(["-l", "-i", "-F", "--max-count", "1", "--max-filesize", "2M", "--", q, ...rs.live.map(r => r.real)], { max: want }));
            } catch (e) {
              notes.push(/** @type {any} */ (e).code === "ENOENT" ? "ripgrep is not installed, so only file names were matched"
                : "the content search failed, so only file names were matched");
            }
          }
        }
      } catch (e) {
        return { results: [], source: { source: here, ok: false, count: 0, error: /** @type {Error} */ (e).message, ...(notes.length ? { note: notes.join("; ") } : {}) } };
      }
      const results = [], seen = new Set();
      for (const c of candidates) {
        if (results.length >= limit) break;
        if (typeof c !== "string" || seen.has(c)) continue;
        seen.add(c);
        // Installed packages are noise in a search, whichever backend found them. They stay
        // reachable by stat and preview; they are just not offered.
        if (c.split(path.sep).includes("node_modules")) continue;
        let d;
        try { d = describe(c, rs); } catch { continue; }
        if (kinds && !kinds.includes(d.kind)) continue;
        results.push({ source: here, path: d.path, name: d.name, kind: d.kind, size: d.size, mtime: d.mtime });
      }
      return { results, source: { source: here, ok: true, count: results.length, ...(notes.length ? { note: notes.join("; ") } : {}) } };
    }

    /** Search the box through the link, optionally with a deadline. Never throws. */
    async function searchBox(q, limit, kinds, deadline) {
      const input = { q, limit, where: "here", ...(kinds ? { kinds } : {}) };
      let timer;
      const late = new Promise(resolve => { timer = setTimeout(() => resolve({ error: { code: "timeout" } }), deadline || 2 ** 31 - 1); });
      /** @type {any} */
      let r;
      try { r = await Promise.race([ctx.remote("files.search", input), late]); }
      catch { r = { error: { code: "box_unreachable" } }; }
      finally { clearTimeout(timer); }
      if (!r || r.error) return { results: [], source: { source: "box", ok: false, count: 0, error: (r && r.error && r.error.code) || "failed" } };
      const d = r.data || {};
      const results = (Array.isArray(d.results) ? d.results : []).slice(0, limit).map(x => tidy(x, "box"));
      const note = Array.isArray(d.sources) && d.sources[0] && d.sources[0].note;
      return { results, source: { source: "box", ok: true, count: results.length, ...(note ? { note } : {}) } };
    }

    ctx.tool("files.search", {
      description: "Find files by name or content on this machine and, from the Mac, on the box too. Only the folders the user chose are searched; secrets and dotfiles never appear.",
      input: { type: "object", required: ["q"], properties: {
        q: { type: "string" }, limit: { type: "integer" },
        kinds: { type: "array", items: { type: "string", enum: KINDS } },
        where: { type: "string", enum: ["all", "here", "box"] } } },
      run: async ({ q, limit = 50, kinds, where = "all" }) => {
        q = q.trim();
        if (!q) throw new Error("q is required");
        limit = clamp(limit, 1, 500);
        kinds = kinds && kinds.length ? kinds : undefined;
        if (role === "box") {
          const r = await searchHere(q, limit, kinds);
          return { results: r.results, sources: [r.source] };
        }
        const [mine, box] = await Promise.all([
          where === "box" ? null : searchHere(q, limit, kinds),
          where === "here" ? null : searchBox(q, limit, kinds, where === "all" ? remoteTimeout : 0),
        ]);
        return { results: merge(mine ? mine.results : [], box ? box.results : [], limit),
          sources: [mine && mine.source, box && box.source].filter(Boolean) };
      },
    });

    ctx.tool("files.stat", {
      description: "Size, dates and kind of one file or folder, on this machine or the box.",
      input: { type: "object", required: ["path"], properties: { path: { type: "string" }, source: { type: "string", enum: ["mac", "box"] } } },
      run: async ({ path: p, source }) => {
        if (target(source) === "box") return forward("files.stat", { path: p });
        const d = describe(p);
        return { source: here, path: d.path, name: d.name, kind: d.kind, size: d.size, mtime: d.mtime, mime: d.mime, dir: d.dir };
      },
    });

    /** A small version of an image: sips on macOS, ImageMagick on Linux. Null when neither works. */
    async function thumbnail(real, ext) {
      if (seam.thumbnail) return seam.thumbnail(real, platform);
      // PNG and GIF keep transparency; everything else becomes JPEG, which every browser shows
      // (a HEIC photo straight from a phone would not).
      const png = ext === ".png" || ext === ".gif";
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-thumb-"));
      const out = path.join(tmp, png ? "thumb.png" : "thumb.jpg");
      try {
        if (platform === "darwin") await run("sips", ["-s", "format", png ? "png" : "jpeg", "-Z", "512", real, "--out", out], { timeout: 15_000 });
        else await run("convert", [real, "-thumbnail", "512x512", out], { timeout: 15_000 });
        return { buf: fs.readFileSync(out), mime: png ? "image/png" : "image/jpeg" };
      } catch { return null; }
      finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }

    ctx.tool("files.preview", {
      description: "A look inside one file: the start of a text file, or a small image. Other kinds say what they are and show nothing.",
      input: { type: "object", required: ["path"], properties: { path: { type: "string" }, source: { type: "string", enum: ["mac", "box"] }, max: { type: "integer" } } },
      run: async ({ path: p, source, max }) => {
        if (target(source) === "box") return forward("files.preview", { path: p, ...(max !== undefined ? { max } : {}) });
        const d = describe(p);
        const other = () => ({ source: here, path: d.path, kind: d.kind, mime: d.mime, size: d.size, preview: null });
        if (d.dir) return other();
        if (d.kind === "image") {
          const t = await thumbnail(d.real, path.extname(d.name).toLowerCase());
          if (t && t.buf && t.buf.length) return { source: here, path: d.path, kind: "image", mime: t.mime, base64: t.buf.toString("base64"), thumbnail: true, size: d.size };
          if (d.size <= SMALL_IMAGE) return { source: here, path: d.path, kind: "image", mime: d.mime, base64: fs.readFileSync(d.real).toString("base64"), thumbnail: false, size: d.size };
          return { source: here, path: d.path, kind: "image", mime: d.mime, base64: null, thumbnail: false, size: d.size, note: "too large to preview" };
        }
        // A file with no known extension (README, LICENSE, Makefile) is tried as text too; the
        // NUL check below turns it away if it is binary.
        if (d.kind !== "text" && d.kind !== "code" && d.kind !== "other") return other();
        const limit = clamp(max ?? PREVIEW, 1, PREVIEW_CAP);
        const buf = Buffer.alloc(Math.min(limit, d.size));
        const fd = fs.openSync(d.real, "r");
        let n = 0;
        try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
        const head = buf.subarray(0, n);
        if (hasNul(head)) return { ...other(), kind: "other" };
        // write() without end() holds back a character cut in half at the limit, rather than
        // ending the preview on a replacement mark.
        const text = new StringDecoder("utf8").write(head);
        const kind = d.kind === "other" ? "text" : d.kind;
        return { source: here, path: d.path, kind, mime: d.kind === "other" ? "text/plain" : d.mime, text, truncated: d.size > n, size: d.size };
      },
    });

    /** One chunk of a file on this machine. The other machine calls this in a loop. */
    function chunk(p, offset = 0, length = CHUNK) {
      const d = describe(p);
      if (d.dir) throw new Error("a folder cannot be fetched");
      if (offset < 0) throw new Error("offset must not be negative");
      const len = clamp(length, 1, CHUNK);
      const fd = fs.openSync(d.real, "r");
      try {
        // Size and date from the open file itself, so they describe exactly what is read.
        const st = fs.fstatSync(fd);
        if (offset > st.size) throw new Error("offset is past the end of the file");
        const buf = Buffer.alloc(Math.min(len, st.size - offset));
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        return { source: here, path: d.path, size: st.size, mtime: st.mtime.toISOString(), offset, length: n,
          base64: buf.subarray(0, n).toString("base64"), done: offset + n >= st.size };
      } finally { fs.closeSync(fd); }
    }

    /** Pull a whole file from the box into VYRE_HOME, chunk by chunk. */
    async function pull(p) {
      const dir = path.join(ctx.paths.root, "files", "fetched", crypto.createHash("sha256").update(p).digest("hex").slice(0, 12));
      const base = path.posix.basename(p).replace(/[\\/\0]/g, "") || "file";
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const final = path.join(dir, base), part = final + ".part";
      const fd = fs.openSync(part, "w", 0o600);
      fs.fchmodSync(fd, 0o600);
      let offset = 0, first = null, ok = false;
      try {
        for (;;) {
          const c = await forward("files.fetch", { path: p, offset, length: CHUNK });
          if (!first) {
            first = { size: c.size, mtime: c.mtime };
            if (c.size > maxFetch) throw new Error(`the file is ${c.size} bytes, more than the ${maxFetch} byte limit for fetching`);
          } else if (c.size !== first.size || c.mtime !== first.mtime) throw new Error("the file changed while fetching");
          if (c.offset !== offset) throw new Error("the box sent the wrong part of the file");
          const buf = Buffer.from(String(c.base64 || ""), "base64");
          if (buf.length !== c.length) throw new Error("a chunk arrived damaged");
          fs.writeSync(fd, buf);
          offset += buf.length;
          if (c.done) break;
          // A chunk with nothing in it that is not the end would loop forever.
          if (!buf.length) throw new Error("the box stopped sending the file");
        }
        if (offset !== first.size) throw new Error("the file changed while fetching");
        ok = true;
      } finally {
        fs.closeSync(fd);
        if (!ok) fs.rmSync(part, { force: true });
      }
      fs.renameSync(part, final);
      return { source: "box", path: p, local: final, size: first.size, mtime: first.mtime };
    }

    ctx.tool("files.fetch", {
      description: "Bring a file from the box to this Mac (source box), saved under Vyre's folder. Called on the machine holding the file, returns one chunk of it.",
      input: { type: "object", required: ["path"], properties: { path: { type: "string" }, source: { type: "string", enum: ["mac", "box"] },
        offset: { type: "integer" }, length: { type: "integer" } } },
      run: async ({ path: p, source, offset, length }) => {
        if (role === "local" && source === "mac") throw new Error("already on this Mac");
        if (target(source) === "box") return pull(p);
        return chunk(p, offset, length);
      },
    });

    // Taildrop: files.send on the Mac, the inbox receiver on the box (drop.js).
    const dropped = drop(ctx, { role, g, cfg });

    return { async stop() { await dropped.stop(); } };
  },
};
