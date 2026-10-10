// @ts-check
// browse: looking inside a VyreDrive share and reading a file from it, through the box.
//
// A phone cannot mount a share (a mounted share has no phone client), and a page in a browser cannot
// speak WebDAV to it either. So the box answers two plain calls: files.drive.list (what is in
// this folder) and files.drive.read (one chunk of this file). The phone's Files view, the Deck and
// the Windows app's panel all use them. Both hold to the same rules as sharing itself: only a
// folder the box offers as a share, every name and every file through the files guard (no secret,
// no dot folder, no link leading out), and a named agent only inside its own granted projects.

import fs from "node:fs";
import path from "node:path";
import { reach, within, withinReal } from "./access.js";
import { classify } from "./kinds.js";

const MIB = 1024 * 1024;
const CHUNK = MIB;
const PAGE = 200, PAGE_MAX = 1000;
const refuse = (message, code = "denied") => Object.assign(new Error(message), { code });
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * @param {any} ctx
 * @param {{ g: any, folder: (p: string) => string, shares: () => Record<string, string>,
 *   tagged?: (thread: string, share: string, rel: string) => string|null }} d
 * `tagged` answers the real path a person's #tag gave this thread for exactly one file, or null.
 */
export function browse(ctx, { g, folder, shares, tagged = () => null }) {
  /**
   * A path inside an offered share, checked: the share's folder (through folder(), the same check
   * sharing runs), the relative path clean, the caller's grant covering it, and the files guard
   * passing it. Every failure is one plain refusal, so an unknown share, an ungranted one and a
   * hidden file read the same to a caller that may not know.
   * @param {string} share @param {string} rel @param {any} meta
   */
  async function resolve(share, rel, meta, { file = false } = {}) {
    const nope = () => refuse("not available (files.drive.status shows the shares on offer)", "not_available");
    const map = shares();
    if (!Object.prototype.hasOwnProperty.call(map, String(share))) throw nope();
    rel = String(rel || "").replace(/^\/+/, "");
    if (rel.includes("\0") || rel.split(/[\\/]+/).includes("..") || path.isAbsolute(rel)) throw refuse("path must be inside the share, with no ..", "bad_input");
    const scope = await reach(ctx, meta && meta.caller, meta);
    const raw = path.join(map[share], rel);
    // A file the person tagged in a chat is readable in that chat, one file and nothing around it.
    const tag = !scope.all && file && meta && meta.thread ? tagged(String(meta.thread), String(share), rel.replace(/\/+$/, "")) : null;
    if (!scope.all && !tag && !within(raw, scope.folders)) throw nope();
    let top;
    try { top = folder(map[share]); } catch { throw nope(); }
    const rs = { live: [{ given: top, real: top }] };
    let safe;
    try { safe = g.resolveSafe(path.join(top, rel), rs); } catch { throw nope(); }
    // The grant is text, and a link inside a granted folder can point at another project in the
    // same share: the real path has to sit inside the real grant too.
    if (tag) { if (safe.real !== tag) throw nope(); }
    else if (!scope.all && !withinReal(safe.real, scope.folders)) throw nope();
    return { top, rs, safe, scope };
  }

  // ---- Generated: images, video and audio the models made, shown inside the project's own folder ----
  // They are artifacts (artifacts owns the bytes and who may see them), so nothing is copied here: a virtual "Generated"
  // folder inside each project's folder lists them through artifacts.list as the asker, and a read goes to
  // artifacts.media.read. A real folder named Generated, if the project has one, is shown together with them.
  const MEDIA_EXT = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif", mp4: "mp4", webm: "webm", mp3: "mp3", wav: "wav", ogg: "ogg", m4a: "m4a" };
  const GENERATED = "Generated";
  /** artifacts keeps the type and size of a media item under `media` (and, for some callers, at the top); read either. */
  const mimeOf = a => String(a.mime || (a.media && a.media.mime) || "");
  const bytesOf = a => Number(a.bytes ?? (a.media && a.media.bytes) ?? 0);
  const realOf = p => { try { return fs.realpathSync(p); } catch { return null; } };

  /** The slug of the project whose home is this folder, or null. */
  async function projectAt(dirReal) {
    try {
      const r = await ctx.call("projects.list", {});
      for (const p of (r && r.data && r.data.projects) || []) {
        const h = typeof p.home === "string" ? realOf(p.home) : null;
        if (h && h === dirReal) return String(p.slug);
      }
    } catch { /* no projects module: nothing is generated here */ }
    return null;
  }

  /**
 * The project's generated media, newest first, each with the name it is shown under. The asker's right to the project is
 * decided before this runs (generated() goes through resolve() on the project's folder, the same grant), and artifacts' own
 * scope for a project is that project's grant, so listing as this module for the one project loses nothing.
 * ASSUMPTION (0.2.0, individual-only): inside a project every item is visible to everyone who reaches the project; there is no
 * private item within a project. Only real project slugs are listed, never the person's own space (project null). Per-item
 * privacy, and forwarding the asker to artifacts, come with Spaces (0.2.5); then this must call as the asker.
 */
  async function mediaOf(slug, meta, realNames = new Set()) {
    const rows = [];
    for (const kind of ["image", "video", "audio"]) {
      const r = await ctx.call("artifacts.list", { kind, project: slug }).catch(() => null);
      const list = r && !r.error && r.data ? (Array.isArray(r.data) ? r.data : r.data.artifacts || r.data.items || []) : [];
      for (const a of list) if (a && a.id) rows.push(a);
    }
    rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    // A name that is already a real file in the folder, or an earlier item's, gets the item's short id before the extension: one rule, used by the listing and the read alike.
    const used = new Set(realNames);
    return rows.map(a => {
      const ext = MEDIA_EXT[String(a.format || "").toLowerCase()] || mimeOf(a).split("/")[1] || "bin";
      const base = String(a.title || a.id).replace(/[\\/:*?"<>|\0\r\n]+/g, "-").replace(/^\.+/, "").trim().slice(0, 80) || String(a.id).slice(0, 8);
      let name = `${base}.${ext}`;
      if (used.has(name.toLowerCase())) name = `${base} (${String(a.id).slice(0, 6)}).${ext}`;
      used.add(name.toLowerCase());
      return { name, a, ext };
    });
  }

  /**
   * Is this path inside the virtual Generated folder of a project? The folder above it goes through resolve() first (the
   * same scope and guard as any listing), so an asker who cannot see the project's folder sees nothing here either.
   */
  async function generated(share, rel, meta) {
    const segs = String(rel || "").replace(/^\/+/, "").split("/").filter(Boolean);
    const i = segs.lastIndexOf(GENERATED);
    if (i < 0 || segs.length - i > 2) return null;
    let parent;
    try { parent = await resolve(share, segs.slice(0, i).join("/"), meta); } catch { return null; }
    if (!fs.statSync(parent.safe.real).isDirectory()) return null;
    const slug = await projectAt(parent.safe.real);
    if (!slug) return null;
    const name = segs.length - i === 2 ? segs[i + 1] : null;
    // The project's own real Generated folder, when it has one and the asker may see it: its names are taken first.
    let realNames = new Set();
    try {
      const real = await resolve(share, segs.slice(0, i + 1).join("/"), meta);
      if (fs.statSync(real.safe.real).isDirectory()) realNames = new Set(fs.readdirSync(real.safe.real).map(n => n.toLowerCase()));
    } catch { /* none */ }
    const media = await mediaOf(slug, meta, realNames);
    // A name inside Generated that is not a media item is an ordinary path (a real file or folder of the project's own).
    if (name && !media.some(m => m.name === name)) return null;
    return { slug, parent, name, media, rel: segs.slice(0, i + 1).join("/") };
  }

  const describe = (rs, p) => {
    const safe = g.resolveSafe(p, rs);
    const st = fs.statSync(safe.real);
    const name = path.basename(safe.path);
    const { kind, mime } = classify(name, st.isDirectory());
    return { name, dir: st.isDirectory(), kind, mime, size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString() };
  };

  ctx.tool("files.drive.list", {
    description: "List a folder inside one of the box's VyreDrive shares: name, kind, size and date per entry, folders first, a page at a time.",
    input: { type: "object", required: ["share"], properties: { share: { type: "string", description: "share name, from files.drive.status" }, path: { type: "string", description: "folder inside the share; default its top" }, limit: { type: "integer", description: "entries per page" }, offset: { type: "integer", description: "entries to skip" } } },
    run: async ({ share, path: rel = "", limit = PAGE, offset = 0 }, meta = {}) => {
      limit = clamp(Number(limit) || PAGE, 1, PAGE_MAX);
      offset = Math.max(0, Number(offset) || 0);
      const g_ = await generated(share, rel, meta);
      if (g_ && g_.name) throw refuse("that is a file; read it with files.drive.read", "bad_input");
      const entries = [];
      let rs, safe, scope;
      if (g_) {
        // The virtual folder: whatever real Generated folder there is (when the guard lets the asker see it), then the media.
        try { ({ rs, safe, scope } = await resolve(share, rel, meta)); } catch { safe = null; }
        if (safe) for (const name of fs.readdirSync(safe.real)) {
          try { const p = path.join(safe.path, name); if (scope.all || withinReal(p, scope.folders)) entries.push(describe(rs, p)); } catch { /* hidden */ }
        }
        for (const m of g_.media) {
          entries.push({ name: m.name, dir: false, kind: String(m.a.kind || "file"), mime: mimeOf(m.a), size: bytesOf(m.a), mtime: String(m.a.created_at || ""), virtual: true, artifact: String(m.a.id) });
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const page = entries.slice(offset, offset + limit);
        return { share, path: "/" + g_.rel, entries: page, total: entries.length, ...(offset + limit < entries.length ? { next: offset + limit } : {}) };
      }
      ({ rs, safe, scope } = await resolve(share, rel, meta));
      if (!fs.statSync(safe.real).isDirectory()) throw refuse("that is a file; read it with files.drive.read", "bad_input");
      for (const name of fs.readdirSync(safe.real)) {
        try {
          const p = path.join(safe.path, name);
          if (!scope.all && !withinReal(p, scope.folders)) continue;
          entries.push(describe(rs, p));
        } catch { /* the guard or a race hid it */ }
      }
      // A project's own folder gets a Generated folder when the project has any generated media and no real folder of that name.
      if (!entries.some(e => e.name === GENERATED)) {
        const slug = await projectAt(safe.real);
        if (slug && (await mediaOf(slug, meta)).length) entries.push({ name: GENERATED, dir: true, kind: "folder", mime: "inode/directory", size: 0, mtime: new Date().toISOString(), virtual: true });
      }
      entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      const page = entries.slice(offset, offset + limit);
      return { share, path: path.posix.normalize("/" + String(rel).replace(/^\/+/, "")).replace(/^\/$/, ""), entries: page, total: entries.length,
        ...(offset + limit < entries.length ? { next: offset + limit } : {}) };
    },
  });

  ctx.tool("files.drive.read", {
    description: "Read one chunk (up to 1 MiB) of a file in a box VyreDrive share, as base64, with its size and an end flag.",
    input: { type: "object", required: ["share", "path"], properties: { share: { type: "string" }, path: { type: "string" }, offset: { type: "integer", description: "start byte; use the next offset for a bigger file" }, length: { type: "integer", description: "chunk size in bytes, up to 1 MiB" } } },
    run: async ({ share, path: rel, offset = 0, length = CHUNK }, meta = {}) => {
      if (!rel) throw refuse("path is required", "bad_input");
      const g_ = await generated(share, rel, meta);
      if (g_ && g_.name) {
        // A generated item: found among what the asker may see, then read as this module (artifacts.media.read is not asker-scoped).
        const m = g_.media.find(x => x.name === g_.name);
        if (!m) throw refuse("not available (files.drive.list shows the files you may read)", "not_available");
        const off = Math.max(0, Number(offset) || 0), len = clamp(Number(length) || CHUNK, 1, CHUNK);
        const r = await ctx.call("artifacts.media.read", { id: m.a.id, offset: off, length: len });
        if (r.error) throw refuse("not available (files.drive.list shows the files you may read)", "not_available");
        const d = r.data || {};
        return { share, path: "/" + String(rel).replace(/^\/+/, ""), kind: String(m.a.kind || "file"), mime: String(d.mime || mimeOf(m.a)), size: Number(d.size || bytesOf(m.a)),
          mtime: String(m.a.created_at || ""), offset: Number(d.offset ?? off), length: Number(d.length || 0), base64: String(d.bytes_b64 || ""), done: d.eof === true, virtual: true, artifact: String(m.a.id) };
      }
      const { safe } = await resolve(share, rel, meta, { file: true });
      offset = Number(offset) || 0;
      if (offset < 0) throw refuse("offset must not be negative", "bad_input");
      length = clamp(Number(length) || CHUNK, 1, CHUNK);
      const fd = fs.openSync(safe.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile()) throw refuse("a folder cannot be read; list it with files.drive.list", "bad_input");
        if (offset > st.size) throw refuse("offset is past the end of the file", "bad_input");
        const buf = Buffer.alloc(Math.min(length, st.size - offset));
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        const { kind, mime } = classify(path.basename(safe.path), false);
        return { share, path: "/" + String(rel).replace(/^\/+/, ""), kind, mime, size: st.size, mtime: st.mtime.toISOString(), offset, length: n,
          base64: buf.subarray(0, n).toString("base64"), done: offset + n >= st.size };
      } finally { fs.closeSync(fd); }
    },
  });

  return { resolve };
}
