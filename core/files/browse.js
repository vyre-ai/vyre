// @ts-check
// browse: looking inside a VyreDrive share and reading a file from it, through the box.
//
// A phone cannot mount a share (Taildrive has no phone client), and a page in a browser cannot
// speak WebDAV to it either. So the box answers two plain calls: files.drive.list (what is in
// this folder) and files.drive.read (one chunk of this file). The phone's Files view, the Deck and
// the Windows app's panel all use them. Both hold to the same rules as sharing itself: only a
// folder the box offers as a share, every name and every file through the files guard (no secret,
// no dot folder, no link leading out), and a named agent only inside its own granted projects.

import fs from "node:fs";
import path from "node:path";
import { reach, within } from "./access.js";
import { classify } from "./kinds.js";

const MIB = 1024 * 1024;
const CHUNK = MIB;
const PAGE = 200, PAGE_MAX = 1000;
const refuse = (message, code = "denied") => Object.assign(new Error(message), { code });
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * @param {any} ctx
 * @param {{ g: any, folder: (p: string) => string, shares: () => Record<string, string> }} d
 */
export function browse(ctx, { g, folder, shares }) {
  /**
   * A path inside an offered share, checked: the share's folder (through folder(), the same check
   * sharing runs), the relative path clean, the caller's grant covering it, and the files guard
   * passing it. Every failure is one plain refusal, so an unknown share, an ungranted one and a
   * hidden file read the same to a caller that may not know.
   * @param {string} share @param {string} rel @param {any} meta
   */
  async function resolve(share, rel, meta) {
    const nope = () => refuse("not available", "not_available");
    const map = shares();
    if (!Object.prototype.hasOwnProperty.call(map, String(share))) throw nope();
    rel = String(rel || "").replace(/^\/+/, "");
    if (rel.includes("\0") || rel.split(/[\\/]+/).includes("..") || path.isAbsolute(rel)) throw refuse("path must be inside the share, with no ..", "bad_input");
    const scope = await reach(ctx, meta && meta.caller);
    const raw = path.join(map[share], rel);
    if (!scope.all && !within(raw, scope.folders)) throw nope();
    let top;
    try { top = folder(map[share]); } catch { throw nope(); }
    const rs = { live: [{ given: top, real: top }] };
    let safe;
    try { safe = g.resolveSafe(path.join(top, rel), rs); } catch { throw nope(); }
    return { top, rs, safe };
  }

  const describe = (rs, p) => {
    const safe = g.resolveSafe(p, rs);
    const st = fs.statSync(safe.real);
    const name = path.basename(safe.path);
    const { kind, mime } = classify(name, st.isDirectory());
    return { name, dir: st.isDirectory(), kind, mime, size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString() };
  };

  ctx.tool("files.drive.list", {
    description: "What is inside a folder of one of the box's VyreDrive shares: name, kind, size and date for each entry, folders first, a page at a time. The phone's Files view uses it, since a phone cannot mount a share. Only a folder the box offers as a share; secrets, dot folders and links leading out never appear. A named agent sees only what its own granted projects reach.",
    input: { type: "object", required: ["share"], properties: { share: { type: "string" }, path: { type: "string" }, limit: { type: "integer" }, offset: { type: "integer" } } },
    run: async ({ share, path: rel = "", limit = PAGE, offset = 0 }, meta = {}) => {
      const { rs, safe } = await resolve(share, rel, meta);
      if (!fs.statSync(safe.real).isDirectory()) throw refuse("that is a file; read it with files.drive.read", "bad_input");
      limit = clamp(Number(limit) || PAGE, 1, PAGE_MAX);
      offset = Math.max(0, Number(offset) || 0);
      const entries = [];
      for (const name of fs.readdirSync(safe.real)) {
        try { entries.push(describe(rs, path.join(safe.path, name))); } catch { /* the guard or a race hid it */ }
      }
      entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      const page = entries.slice(offset, offset + limit);
      return { share, path: path.posix.normalize("/" + String(rel).replace(/^\/+/, "")).replace(/^\/$/, ""), entries: page, total: entries.length,
        ...(offset + limit < entries.length ? { next: offset + limit } : {}) };
    },
  });

  ctx.tool("files.drive.read", {
    description: "Read one chunk (up to 1 MiB) of a file in one of the box's VyreDrive shares, as base64, with its size and whether that was the end: call again with the next offset for a bigger file. Same rules as files.drive.list.",
    input: { type: "object", required: ["share", "path"], properties: { share: { type: "string" }, path: { type: "string" }, offset: { type: "integer" }, length: { type: "integer" } } },
    run: async ({ share, path: rel, offset = 0, length = CHUNK }, meta = {}) => {
      if (!rel) throw refuse("path is required", "bad_input");
      const { safe } = await resolve(share, rel, meta);
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
}
