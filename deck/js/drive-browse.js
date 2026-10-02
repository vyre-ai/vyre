// @ts-check
// The Files view's words and reads, without the DOM (deck/views/files.js draws them).
//
// A phone cannot mount a VyreDrive share, so the box answers two calls: files.drive.list
// { share, path?, limit?, offset? } -> { share, path, entries: [{ name, dir, kind, mime, size, mtime }],
// total, next? } and files.drive.read { share, path, offset?, length? } -> { size, mime, kind,
// offset, length, base64, done } (1 MiB chunks). Every refusal is code not_available, one answer for
// an unknown share, an ungranted folder and a hidden file, so the view says one thing for all.

/** Nothing bigger than this is pulled just to look at it; a bigger file offers a download instead. */
export const PREVIEW_MAX = 8 * 1024 * 1024;

/** @param {number} n bytes */
export function sizeWord(n) {
  if (!(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** "/a/b" plus "c" is "/a/b/c"; the share's top is "". @param {string} dir @param {string} name */
export const child = (dir, name) => `${String(dir || "").replace(/\/+$/, "")}/${name}`;

/** The folder above a path ("" at the top). @param {string} p */
export const parent = p => String(p || "").replace(/\/+$/, "").split("/").slice(0, -1).join("/");

/**
 * The trail for a path: the share, then each folder. `path` is "" for the share's top.
 * @param {string} share @param {string} p
 * @returns {{ label: string, path: string }[]}
 */
export function crumbs(share, p) {
  const out = [{ label: share, path: "" }];
  let at = "";
  for (const seg of String(p || "").split("/").filter(Boolean)) { at = child(at, seg); out.push({ label: seg, path: at }); }
  return out;
}

/**
 * How a file can be shown: "image", "text", "pdf", or "other" (a download). The box says `kind`
 * and `mime`; a kind it does not know falls back to the mime.
 * @param {{ kind?: string, mime?: string, dir?: boolean }} e
 * @returns {"image"|"text"|"pdf"|"other"}
 */
export function previewKind(e) {
  if (!e || e.dir) return "other";
  const mime = String(e.mime || "");
  if (e.kind === "image" || /^image\/(png|jpe?g|gif|webp)$/.test(mime)) return "image";
  if (/^image\//.test(mime)) return "other"; // svg and the like: a download, never a page
  if (mime === "application/pdf" || e.kind === "pdf") return "pdf";
  if (e.kind === "text" || e.kind === "code" || /^text\//.test(mime) || /json|xml|markdown/.test(mime)) return "text";
  return "other";
}

/** @param {string} b64 */
export function bytesOf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Reads a whole file, a chunk at a time, up to `max` bytes. `call` is api.js's attempt. A file
 * bigger than `max` is refused before its first chunk is pulled twice: `tooBig` with the size.
 * @param {(name: string, input: any) => Promise<{ data?: any, error?: any }>} call
 * @param {string} share @param {string} path @param {number} [max]
 * @returns {Promise<{ bytes: Uint8Array, mime: string, size: number } | { tooBig: true, size: number, mime: string } | { error: any }>}
 */
export async function readFile(call, share, path, max = PREVIEW_MAX) {
  /** @type {Uint8Array[]} */ const parts = [];
  let offset = 0, size = 0, mime = "";
  for (let guard = 0; guard < 4096; guard++) {
    const r = await call("files.drive.read", { share, path, offset });
    if (r.error) return { error: r.error };
    const d = r.data || {};
    size = Number(d.size) || 0; mime = String(d.mime || mime);
    if (size > max) return { tooBig: true, size, mime };
    const chunk = bytesOf(String(d.base64 || ""));
    parts.push(chunk);
    offset += chunk.length;
    if (d.done || !chunk.length) break;
  }
  const bytes = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { bytes, mime, size };
}

/**
 * Every page of a folder: files.drive.list follows `next` until it stops.
 * @param {(name: string, input: any) => Promise<{ data?: any, error?: any }>} call
 * @param {string} share @param {string} path
 */
export async function listAll(call, share, path) {
  /** @type {any[]} */ const entries = [];
  let offset = 0;
  for (let guard = 0; guard < 50; guard++) {
    const r = await call("files.drive.list", { share, path, offset });
    if (r.error) return { error: r.error };
    entries.push(...(r.data?.entries || []));
    if (typeof r.data?.next !== "number") return { entries };
    offset = r.data.next;
  }
  return { entries };
}

/** The one plain line for a refusal. @param {any} err */
export function whyNot(err) {
  if (err && err.missing) return "Your server does not have the Files tools yet. Update it, then open Files again.";
  if (err && (err.code === "not_available" || err.code === "denied")) return "That folder is not available.";
  return String((err && err.message) || err || "Something went wrong.");
}
