// @ts-check
// box: files on the box itself, under the folders the user chose (config glass.roots).
//
// Each root is named by its folder's basename, so a path reads "<root>/<rel>", and the empty
// path lists the roots. The box has no screen (ADR 0005): it is a files-only target.
//
// LocalTree does the work for one folder and is also what the fake computerd serves in tests,
// so the box and an agent's computer run the same code against a disk. Every path goes through
// guard.js first; nothing here opens a path the guard has not resolved.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { resolveIn, checkRel, hidden, inside, deniedSegments, MAX_ENTRIES, TRASH, UPLOAD_PREFIX } from "../guard.js";
import { mimeOf } from "../mime.js";
import { parseRange, counter } from "../bytes.js";

/**
 * @typedef {{ name: string, kind: "dir"|"file"|"link"|"other", size: number|null, mtime: number|null, to?: "dir"|"file"|null }} Entry
 * @typedef {{ name: string, kind: "dir"|"file"|"other", size: number, mtime: number, mime: string }} Stat
 * @typedef {{ stream: import("node:stream").Readable, start: number, end: number, total: number, partial: boolean }} Read
 */

const kindOf = st => st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";

/** A trash name that sorts by when, and keeps the original name readable. */
export const trashName = (name, at = Date.now()) => `${new Date(at).toISOString().replace(/[:.]/g, "-")}-${name}`;

/** One folder on this machine's disk, behind the guard. Paths are relative to it. */
export class LocalTree {
  /** @param {string} dir an absolute folder */
  constructor(dir) {
    this.dir = dir;
    this.now = () => Date.now();
  }

  /** @returns {Promise<{ entries: Entry[], truncated: boolean }>} */
  async list(rel) {
    const { real, segments } = resolveIn(this.dir, rel);
    if (!fs.statSync(real).isDirectory()) throw new Error(`"${rel}" is not a folder`);
    const realRoot = fs.realpathSync(this.dir);
    /** @type {Entry[]} */
    const entries = [];
    let truncated = false;
    const dir = await fs.promises.opendir(real);
    for await (const d of dir) {
      if (hidden(d.name, segments)) continue;
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      const p = path.join(real, d.name);
      if (d.isSymbolicLink()) {
        // Shown as a link; followed only when it lands inside the root on a name the guard allows.
        /** @type {Entry} */
        const e = { name: d.name, kind: "link", size: null, mtime: null, to: null };
        try {
          const target = fs.realpathSync(p);
          const under = path.relative(realRoot, target);
          if (inside(realRoot, target) && !(under && deniedSegments(under.split(path.sep)))) {
            const st = fs.statSync(target);
            const k = kindOf(st);
            if (k !== "other") Object.assign(e, { to: k, size: k === "file" ? st.size : null, mtime: st.mtimeMs });
          }
        } catch {}
        entries.push(e);
        continue;
      }
      let st = null;
      try { st = fs.lstatSync(p); } catch { continue; }
      const kind = kindOf(st);
      entries.push({ name: d.name, kind, size: kind === "file" ? st.size : null, mtime: st.mtimeMs });
    }
    entries.sort((a, b) => Number(b.kind === "dir" || b.to === "dir") - Number(a.kind === "dir" || a.to === "dir") || a.name.localeCompare(b.name));
    return { entries, truncated };
  }

  /** @returns {Promise<Stat>} */
  async stat(rel) {
    const { real, segments } = resolveIn(this.dir, rel);
    const st = fs.statSync(real);
    const name = segments.length ? segments[segments.length - 1] : path.basename(this.dir);
    return { name, kind: kindOf(st), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs, mime: st.isFile() ? mimeOf(name) : "inode/directory" };
  }

  /**
   * The bytes of a file, or of one range of it.
   * @param {string} rel @param {string} [range] a Range header
   * @returns {Promise<Read>}
   */
  async read(rel, range) {
    const { real } = resolveIn(this.dir, rel);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new Error(`"${rel}" is not a file`);
    const total = st.size;
    const r = total ? parseRange(range, total) : null;
    const start = r ? r.start : 0, end = r ? r.end : Math.max(0, total - 1);
    const stream = total ? fs.createReadStream(real, { start, end }) : fs.createReadStream(real);
    return { stream, start, end, total, partial: Boolean(r) };
  }

  /**
   * Stream `body` into `rel`: into a temp file in the same folder first, counted, then renamed
   * into place only when exactly `size` bytes arrived. Never reads the body into memory.
   * @param {string} rel @param {import("node:stream").Readable} body
   * @param {{ size: number, overwrite?: boolean }} opts
   */
  async write(rel, body, { size, overwrite = false }) {
    const { real } = resolveIn(this.dir, rel, { create: true });
    const exists = fs.existsSync(real);
    if (exists && !overwrite) throw Object.assign(new Error(`"${rel}" already exists; upload with another name, or say overwrite to replace it`), { code: "exists" });
    if (exists && !fs.statSync(real).isFile()) throw Object.assign(new Error(`"${rel}" is a folder; upload with another name`), { code: "exists" });
    const temp = path.join(path.dirname(real), UPLOAD_PREFIX + crypto.randomBytes(8).toString("hex"));
    const count = counter(size);
    try {
      await pipeline(body, count, fs.createWriteStream(temp, { flags: "wx", mode: 0o644 }));
      if (count.bytes !== size) throw Object.assign(new Error(`the upload announced ${size} bytes and sent ${count.bytes}`), { code: "wrong_size" });
      if (overwrite) fs.renameSync(temp, real);
      else {
        // A hard link fails if the name was taken meanwhile, where a rename would clobber it.
        try { fs.linkSync(temp, real); fs.rmSync(temp, { force: true }); }
        catch (e) {
          if (/** @type {any} */ (e).code === "EEXIST") throw Object.assign(new Error(`"${rel}" already exists; upload with another name, or say overwrite to replace it`), { code: "exists" });
          if (fs.existsSync(real)) throw Object.assign(new Error(`"${rel}" already exists; upload with another name, or say overwrite to replace it`), { code: "exists" });
          fs.renameSync(temp, real);
        }
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return { size: count.bytes };
  }

  async move(from, to) {
    const src = resolveIn(this.dir, from);
    if (!src.segments.length) throw new Error("a root cannot be moved");
    // Move the entry itself, never what a link points at.
    const own = path.join(fs.realpathSync(path.dirname(src.abs)), path.basename(src.abs));
    const dst = resolveIn(this.dir, to, { create: true });
    if (fs.existsSync(dst.real)) throw new Error(`"${to}" already exists`);
    if (inside(own, dst.real)) throw new Error("a folder cannot move inside itself");
    try { fs.renameSync(own, dst.real); }
    catch (e) { throw new Error(/** @type {any} */ (e).code === "EXDEV" ? "that move crosses disks, which Glass does not do" : `could not move: ${/** @type {Error} */ (e).message}`); }
  }

  async mkdir(rel) {
    const { real } = resolveIn(this.dir, rel, { create: true });
    try { fs.mkdirSync(real); }
    catch (e) { throw new Error(/** @type {any} */ (e).code === "EEXIST" ? `"${rel}" already exists` : `could not make "${rel}"`); }
  }

  /** Move into the root's trash folder. There is no hard delete. @returns {Promise<{ to: string }>} */
  async trash(rel) {
    const src = resolveIn(this.dir, rel);
    if (!src.segments.length) throw new Error("a root cannot be trashed");
    if (src.segments[0] === TRASH) throw new Error("that is already in the trash");
    const own = path.join(fs.realpathSync(path.dirname(src.abs)), path.basename(src.abs));
    const bin = path.join(fs.realpathSync(this.dir), TRASH);
    fs.mkdirSync(bin, { recursive: true });
    const name = trashName(src.segments[src.segments.length - 1], this.now());
    fs.renameSync(own, path.join(bin, name));
    return { to: `${TRASH}/${name}` };
  }
}

/** The box target: several LocalTrees, one per configured root, addressed "<root>/<rel>". */
export class BoxProvider {
  /** @param {string[]} dirs absolute folders from config glass.roots */
  constructor(dirs) {
    /** @type {Map<string, LocalTree>} */
    this.trees = new Map();
    for (const dir of dirs) {
      let name = path.basename(dir) || "root";
      for (let i = 2; this.trees.has(name); i++) name = `${path.basename(dir)}-${i}`;
      this.trees.set(name, new LocalTree(dir));
    }
  }

  roots() { return [...this.trees.keys()].map(name => ({ name, path: name })); }

  /** Split "<root>/<rel>" into its tree and the rest, after the guard has seen the whole path. */
  split(p) {
    const segments = checkRel(p);
    if (!segments.length) return { name: "", tree: null, rel: "" };
    const tree = this.trees.get(segments[0]);
    if (!tree) throw new Error(`there is no root named "${segments[0]}" on the box`);
    return { name: segments[0], tree, rel: segments.slice(1).join("/") };
  }

  at(p) {
    const s = this.split(p);
    if (!s.tree) throw new Error("say which root: the box's top level only holds its roots");
    return s;
  }

  async list(p) {
    const s = this.split(p);
    if (!s.tree) {
      const entries = [...this.trees].map(([name, t]) => {
        let mtime = null;
        try { mtime = fs.statSync(t.dir).mtimeMs; } catch {}
        return /** @type {Entry} */ ({ name, kind: "dir", size: null, mtime });
      });
      return { root: "", path: "", entries, truncated: false };
    }
    const r = await s.tree.list(s.rel);
    return { root: s.name, path: [s.name, s.rel].filter(Boolean).join("/"), ...r };
  }

  async stat(p) { const s = this.split(p); if (!s.tree) return { name: "", kind: "dir", size: 0, mtime: 0, mime: "inode/directory" }; return s.tree.stat(s.rel); }
  async read(p, range) { const s = this.at(p); return s.tree.read(s.rel, range); }
  async write(p, body, opts) { const s = this.at(p); return s.tree.write(s.rel, body, opts); }
  async mkdir(p) { const s = this.at(p); return s.tree.mkdir(s.rel); }

  async move(from, to) {
    const a = this.at(from), b = this.at(to);
    if (a.name !== b.name) throw new Error("moves stay inside one root");
    return a.tree.move(a.rel, b.rel);
  }

  async trash(p) {
    const s = this.at(p);
    const r = await s.tree.trash(s.rel);
    return { to: `${s.name}/${r.to}` };
  }
}
