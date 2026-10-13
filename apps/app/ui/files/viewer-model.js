// @ts-check
// The parts of the file viewer that are decisions: reading bytes as text, the edit state and its unsaved-changes guard, tags and checklists in markdown, and the chat's file card. Pure.

import { viewerKind } from "./kinds.js";

/** @param {ArrayLike<number>} bytes */
export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  let odd = 0;
  for (let i = 0; i < n; i++) { const b = bytes[i]; if (b === 0) return true; if (b < 9 || (b > 13 && b < 32)) odd++; }
  return n > 0 && odd / n > 0.1;
}

/** UTF-8 to text without Node or TextDecoder (a phone's engine may lack it); a bad sequence is U+FFFD. @param {ArrayLike<number>} bytes */
export function textOfBytes(bytes) {
  let s = "", i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp = 0xfffd, len = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0 && (bytes[i + 1] & 0xc0) === 0x80) { cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f); len = 2; }
    else if (b >= 0xe0 && b < 0xf0 && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) { cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f); len = 3; if (cp < 0x800 || (cp >= 0xd800 && cp < 0xe000)) { cp = 0xfffd; len = 1; } }
    else if (b >= 0xf0 && b < 0xf5 && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80 && (bytes[i + 3] & 0xc0) === 0x80) { cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f); len = 4; if (cp < 0x10000 || cp > 0x10ffff) { cp = 0xfffd; len = 1; } }
    s += String.fromCodePoint(cp);
    i += len;
  }
  return s;
}

/** Text to UTF-8 bytes. @param {string} text */
export function bytesOfText(text) {
  const out = [];
  for (const ch of text) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** @param {ArrayLike<number>} bytes */
export function base64Of(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b === undefined ? "=" : B64[(n >> 6) & 63]) + (c === undefined ? "=" : B64[n & 63]);
  }
  return s;
}

/**
 * The edit state of a text file: what was last saved, what is typed. Saving is by the caller's function (the Drive's new version, or an agent's or project's instructions); a failed save keeps the draft.
 * @param {string} saved @param {string} draft
 */
export const editState = (saved, draft) => ({ dirty: saved !== draft, canSave: saved !== draft });

/** Leaving (closing, switching file or version, leaving edit) with unsaved changes asks first. @param {{ dirty: boolean }} s */
export const needsGuard = s => s.dirty;

/** What a save should do about a version that moved under the person: the server keeps both and flags a conflict, so the viewer says so. @param {{ conflict?: boolean }} r */
export const saveWords = r => (r && r.conflict ? "Saved as a new version. Someone else changed this file too, so both are kept." : "Saved.");

/** `@name` and `#name` in a line of text, as parts, so a renderer can draw chips. @param {string} text */
export function tagParts(text) {
  /** @type {({ t: "text", v: string } | { t: "tag", v: string, kind: "mention" | "record" })[]} */ const out = [];
  const re = /(^|[\s(])([@#][A-Za-z0-9][\w.-]*[A-Za-z0-9_]|[@#][A-Za-z0-9])/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    if (start > last) out.push({ t: "text", v: text.slice(last, start) });
    out.push({ t: "tag", v: m[2], kind: m[2][0] === "@" ? "mention" : "record" });
    last = start + m[2].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** A checklist item's marker at the start of a list item's text: `[ ] ` or `[x] `. @param {string} text */
export function taskOf(text) {
  const m = /^\[( |x|X)\]\s+(.*)$/s.exec(text);
  return m ? { checked: m[1] !== " ", text: m[2] } : null;
}

/** Flip checklist item number `n` (0-based, in document order) in the source, for a click on its box. @param {string} src @param {number} n */
export function toggleTask(src, n) {
  let i = -1;
  return src.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\]/gm, (all, lead, mark) => (++i === n ? `${lead}[${mark === " " ? "x" : " "}]` : all));
}

/** Headings of a markdown document, for an outline. @param {string} src */
export function outline(src) {
  /** @type {{ level: number, title: string, line: number }[]} */ const out = [];
  let fence = false;
  String(src).split("\n").forEach((l, i) => {
    if (/^\s{0,3}(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, title: m[2], line: i + 1 });
  });
  return out;
}

/**
 * The chat's file card for a file a model made or changed: a name, "created" or "edited", and the lines added and removed. From a chat `diff` block's file ({ path, op, add, del }).
 * @param {{ path: string, op: string, add?: number, del?: number }} f
 */
export function fileCardOf(f) {
  const path = String(f.path || "");
  const name = path.split("/").pop() || path;
  const action = f.op === "create" ? "created" : f.op === "delete" ? "deleted" : "edited";
  const add = Math.max(0, Number(f.add) || 0), del = Math.max(0, Number(f.del) || 0);
  return { path, name, kind: viewerKind(name), action, add, del, openable: action !== "deleted", line: action === "created" ? `created, +${add}` : action === "deleted" ? "deleted" : `edited, +${add} −${del}` };
}

/** "Changed by <agent>" for a version row of files.drive.versions ({ by: "agent:kit" | "person:per_x" }). @param {{ by?: string | null }} v @param {(id: string) => string} [nameOf] */
export function changedBy(v, nameOf = id => id) {
  const by = String(v?.by || "");
  if (!by) return "";
  const [kind, ...rest] = by.split(":");
  const id = rest.join(":");
  return kind === "agent" ? `Changed by ${nameOf(id)}` : kind === "person" ? `Changed by ${nameOf(id)}` : `Changed by ${nameOf(by)}`;
}
