import { dayOf } from "../../src/time/show.js";
// The pure half of Drive's real source: files.drive.list entries and files.drive.read chunks as the lines the screen shows. The box has already
// refused secrets, dot folders and links leading out; nothing here decides what may be seen.

export type Entry = { name: string; dir: boolean; kind: string; mime: string; size: number; mtime: string; virtual?: boolean; artifact?: string };
export type Listing = { share: string; path: string; entries: Entry[]; total: number; next?: number };
export type Share = { name: string; path?: string; access: string; shared: boolean };
export type Status = { enabled: boolean; why?: string; fix?: string; access?: string; shares: Share[] };
export type Chunk = { share: string; path: string; kind: string; mime: string; size: number; mtime: string; offset: number; length: number; base64: string; done: boolean };

/** 184 KB, 2.1 MB: one decimal from a megabyte up. */
export function sizeWord(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** The line under an entry: a folder says nothing but its date; a file says its size and date. */
export function entryLine(e: Entry): string {
  const d = e.mtime ? new Date(e.mtime) : null;
  const when = d && !Number.isNaN(d.getTime()) ? dayOf(d.getTime()) : "";
  return [e.dir ? "" : sizeWord(e.size), when].filter(Boolean).join(", ");
}

/** "/a/b" plus "c" is "/a/b/c"; the share's top is "". */
export const join = (path: string, name: string): string => `${path.replace(/\/+$/, "")}/${name}`;
/** One level up, "" at the top. */
export const parent = (path: string): string => path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
/** Each step of a path as a name and where tapping it goes. */
export function crumbs(share: string, path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [{ name: share, path: "" }, ...parts.map((p, i) => ({ name: p, path: "/" + parts.slice(0, i + 1).join("/") }))];
}

/** A file whose first chunk the app can show as text. Anything else says what it is. */
export const isText = (e: { mime: string; kind: string }): boolean => /^text\//.test(e.mime) || /json|xml|yaml|markdown/.test(e.mime) || e.kind === "text" || e.kind === "code";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** base64 to bytes, with no runtime function the phone's JS engine may lack. */
export function bytesOf(b64: string): number[] {
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const c of b64.replace(/=+$/, "")) {
    const v = B64.indexOf(c);
    if (v < 0) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return out;
}
/** UTF-8 text from bytes; bytes that are not valid UTF-8 come out as the replacement mark, never as an error. */
export function textOf(bytes: number[]): string {
  let s = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const n = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 0;
    if (!n || i + n > bytes.length) { s += "�"; i += 1; continue; }
    let cp = n === 1 ? b : b & (0xff >> (n + 1));
    let ok = true;
    for (let k = 1; k < n; k++) { const x = bytes[i + k]; if ((x & 0xc0) !== 0x80) { ok = false; break; } cp = (cp << 6) | (x & 0x3f); }
    s += ok ? String.fromCodePoint(cp) : "�";
    i += ok ? n : 1;
  }
  return s;
}

/** The words for a refusal from the box. Every refusal is the same "not available" on purpose (a hidden file reads like a missing one). */
export function driveRefusal(code: string | undefined, message: string): string {
  if (code === "not_available") return "That folder is not available on your home.";
  if (code === "denied") return "You may not open that.";
  return message || "Drive did not answer.";
}
