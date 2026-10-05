// The pure half of the Space's own Drive (files.drive.space.list, read, upload, versions, restore): the versioned, permissioned files of the space, not the box's shared folders.
// The box lists files under a folder as paths; a folder is the first step of a path below the one you are in.

/** A listing entry. A chat's folder comes with the chat's title and an `open` flag: false when the caller is not in the chat (files.drive.space.list). */
export type SpaceEntry = { path?: string; name?: string; size?: number; ver?: number; version?: number; at?: number | string; mtime?: number | string; by?: string; title?: string; open?: boolean; dir?: boolean; folder?: boolean };
export type Item = { name: string; dir: boolean; path: string; size: number; ver: number; at: number; /** A chat folder the caller is not in: its name shows greyed and it does not open. */ locked?: boolean };
export type Version = { ver: number; size: number; at: number; by?: string; base?: number };

const ms = (v: unknown): number => { if (typeof v === "number") return v; const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isNaN(t) ? 0 : t; };
const clean = (p: string): string => p.replace(/^\/+|\/+$/g, "");

/** The files and folders directly under `prefix`, folders first. A folder is a path step with more below it. */
export function children(entries: SpaceEntry[], prefix: string): Item[] {
  const base = clean(prefix);
  const out = new Map<string, Item>();
  for (const e of entries) {
    const full = clean(String(e.path ?? e.name ?? ""));
    if (!full || (base && !full.startsWith(base + "/"))) continue;
    const rest = base ? full.slice(base.length + 1) : full;
    const [head, ...more] = rest.split("/");
    if (!head) continue;
    const path = base ? `${base}/${head}` : head;
    if (more.length || e.dir || e.folder) {
      const cur = out.get(head);
      const named = !more.length && typeof e.title === "string" && e.title.trim() ? e.title.trim() : cur?.name && cur.name !== head ? cur.name : head;
      const locked = cur?.locked || e.open === false;
      out.set(head, { name: named, dir: true, path, size: 0, ver: 0, at: Math.max(cur?.at ?? 0, ms(e.at ?? e.mtime)), ...(locked ? { locked: true } : {}) });
    }
    else out.set(head, { name: head, dir: false, path, size: Number(e.size ?? 0), ver: Number(e.ver ?? e.version ?? 1), at: ms(e.at ?? e.mtime) });
  }
  return [...out.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export const dayOf = (at: number): string => (at ? new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "");

export function sizeOf(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** The line under a file: its size, date and version. A folder says nothing. */
export const itemLine = (i: Item): string => (i.dir ? "" : [sizeOf(i.size), dayOf(i.at), i.ver > 1 ? `version ${i.ver}` : ""].filter(Boolean).join(", "));

/** "alex" from "person:per_x" is not known here: the box gives an id, so the line says "by" only for a name that reads like one. */
export const versionLine = (v: Version, head: number): string => [`Version ${v.ver}${v.ver === head ? ", current" : ""}`, sizeOf(v.size), dayOf(v.at), v.base && v.base !== v.ver - 1 ? `from version ${v.base}` : ""].filter(Boolean).join(", ");

/** The path of a new file in the folder you are in. A name with a slash, a dot-dot or a backslash is refused before the box is asked. */
export function uploadPath(prefix: string, name: string): { path: string } | { error: string } {
  const n = name.trim();
  if (!n) return { error: "That file has no name." };
  if (/[\\]|\.\.|\//.test(n)) return { error: "A file name cannot hold a slash or two dots." };
  const base = clean(prefix);
  return { path: base ? `${base}/${n}` : n };
}

/** base64 of bytes with no runtime function the phone's engine may lack. */
export function toBase64(bytes: Uint8Array): string {
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += T[(n >> 18) & 63] + T[(n >> 12) & 63] + (i + 1 < bytes.length ? T[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? T[n & 63] : "=");
  }
  return s;
}
export const MAX_UPLOAD = 8 * 1024 * 1024;

export function spaceDriveRefusal(code: string | undefined, message: string): string {
  if (code === "unavailable") return "This space has no Drive yet.";
  if (code === "no_such_tool") return "This box does not have the space's Drive yet. Update your Vyre.";
  if (code === "too_large") return "That file is bigger than 8 MB. The app sends files up to 8 MB.";
  if (code === "denied") return "You may not do that in this space's Drive.";
  if (code === "not_found") return "That file is not there, or you may not read it.";
  if (code === "presence_required") return "That needs you. Approve on this device, then try again.";
  if (code === "bad_input") return message || "That path is not allowed.";
  return message || "Drive did not answer.";
}

// ------------------------------------------------------------------------------------------------------------------------------------ shared links

/** One row of files.drive.link.list. The bytes are never in it. */
export type LinkRow = { code: string; url: string; name: string; path: string; version: number | null; size: number; made_at: number; expires: number; opens: number; active: boolean };
export const LINK_DAYS = 7;
const DAY = 86_400_000;

/** The line under a link: when it stops, how often it was opened, or that it no longer works. */
export function linkLine(l: LinkRow, now: number): string {
  if (!l.active) return l.expires <= now ? `Expired ${dayOf(l.expires)}` : "Stopped";
  const left = Math.max(1, Math.ceil((l.expires - now) / DAY));
  const opened = l.opens ? `opened ${l.opens} ${l.opens === 1 ? "time" : "times"}` : "not opened yet";
  return `Works for ${left} more ${left === 1 ? "day" : "days"}, ${opened}`;
}

/** Working links first, newest first inside each; the stopped ones follow. */
export const linksSorted = (rows: LinkRow[]): LinkRow[] => [...rows].sort((a, b) => Number(b.active) - Number(a.active) || b.made_at - a.made_at);

/** The address to copy: the box's own origin and the link's path. */
export const linkAddress = (origin: string, l: Pick<LinkRow, "url">): string => `${origin.replace(/\/+$/, "")}${l.url.startsWith("/") ? "" : "/"}${l.url}`;

/** What the Ask card says before anything is made. The copy is one version of one file, so a later edit is not shown. */
export function linkAsk(name: string, days = LINK_DAYS): { title: string; why: string } {
  return { title: `Share ${name} with a link?`, why: `Anyone with the link can read this version of it for ${days} days. It is a copy, so a later edit is not shown. It is not sealed, so it can leave. You can stop the link at any time.` };
}

export function linkRefusal(code: string | undefined, message: string): string {
  if (code === "too_large") return "That file is bigger than 8 MB, so it cannot be shared with a link.";
  if (code === "not_found") return "That link or file is not there, or you may not read it.";
  if (code === "no_such_tool") return "This box cannot make links yet. Update your Vyre.";
  return spaceDriveRefusal(code, message);
}
