// The pure half of Glass in the web app: what glass.targets, glass.open, glass.take and glass.files.* answer, the words, and the rules the Deck's Glass keeps (ADR 0005):
// who holds the keyboard, the stream's quality by link, the reconnect backoff, and the one line for each take-over event. No React, no DOM: node tests import it.

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type Holder = { surface: string | null; since: number | null; private: boolean };
export type Target = { target: string; state: string; screen: boolean; viewers: number; width: number | null; height: number | null; holder: Holder | null };
export type Link = { path: string; latencyMs: number | null };

/** The surface that holds the keyboard, from a targets row or an event payload. */
export function holderOf(t: unknown): Holder | null {
  if (!t) return null;
  if (typeof t === "string") return { surface: t, since: null, private: false };
  const o = t as { surface?: unknown; since?: unknown; private?: unknown };
  return { surface: str(o.surface) || null, since: num(o.since) ?? (o.since ? Number(o.since) || null : null), private: Boolean(o.private) };
}
const viewerCount = (v: unknown): number => (Array.isArray(v) ? v.length : Number(v) || 0);

/** glass.targets: the computers (and the box) Glass can show. */
export function pickTargets(d: unknown): Target[] {
  return (Array.isArray(d) ? d : []).filter((x) => x && typeof x.target === "string").map((x) => ({
    target: x.target as string, state: str(x.state), screen: x.screen !== false, viewers: viewerCount(x.viewers), width: num(x.width), height: num(x.height), holder: holderOf(x.takeover),
  }));
}

const STATE: Record<string, string> = { working: "working", idle: "idle", frozen: "resting", running: "running", starting: "starting", none: "no computer yet", stopped: "stopped" };
export const stateWord = (s: string): string => STATE[s] || s;

/** A surface claim like "phone:ab12" as who it is. */
export function surfaceKind(surface: string | null | undefined): string {
  const k = String(surface || "").split(":")[0];
  return k === "phone" ? "a phone" : k === "capsule" ? "Lumen" : k === "deck" || k === "glass" || k === "web" ? "a laptop" : k || "another screen";
}
export function yourDevice(surface: string | null | undefined): string {
  const k = String(surface || "").split(":")[0];
  return k === "phone" ? "Your phone" : k === "capsule" ? "Your Lumen" : k === "deck" || k === "glass" || k === "web" ? "Your laptop" : "Your other screen";
}

/** Elapsed ms as 2:14 or 1:02:14. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}
export function size(n: unknown): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "";
  let v = Number(n);
  if (v < 1024) return `${v} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
/** A modified time as "14:32" today, "24 Sep" this year, else "24 Sep 2025". */
export function stamp(ms: unknown, now = new Date()): string {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}) });
}

const WORDS: Record<string, string> = {
  outside_root: "That path is outside the folders Glass can reach.",
  denied_path: "That place holds keys or settings, so Glass keeps it closed.",
  not_found: "That is not there any more. Someone may have moved it.",
  exists: "Something with that name is already there.",
  too_large: "That file is larger than Glass takes in one upload.",
  presence_required: "Your server still asks for a passkey to take the keyboard. Update your server: take-over needs none now.",
  not_holder: "Another screen has the keyboard, so this one cannot hand it back.",
  held: "Someone else has the keyboard right now.",
  shield_unavailable: "Signing in privately is not available on your server yet: the agent's computer cannot hide the page from the agent.",
  no_screen: "This computer has no screen to show.",
  offline: "Your server did not answer. It may be asleep or out of reach.",
};
/** A glass.* error in plain words. A box without the module says so. */
export function errText(e: { code?: string; message?: string } | null | undefined): string {
  if (!e) return "";
  if (e.code === "no_such_tool") return "The glass module is not running on this machine.";
  return (e.code && WORDS[e.code]) || e.message || "That did not go through.";
}

// ---- the stream ----

export const relayed = (l: Link | null): boolean => Boolean(l && (l.path === "relay" || l.path === "peer-relay"));
export const latencyLabel = (l: Link | null): string => (l && l.latencyMs !== null && Number.isFinite(l.latencyMs) ? `${Math.round(l.latencyMs)} ms` : "");
/** [quality, compression] for this link: a slow or relayed one sends fewer, smaller frames. `slowNet` is the browser's own saveData or 2g/3g. */
export const levels = (l: Link | null, slowNet = false): [number, number] => (slowNet || relayed(l) ? [2, 6] : [6, 2]);
/** The wait before the next reconnect, 1, 2, 4 ... 30 s. */
export const nextBackoff = (s: number): number => Math.min(30, s * 2);

export type Conn = "connecting" | "live" | "hidden" | "waiting" | "refused" | "ended" | "error" | "noscreen" | "failed";
/** What the frame's close means: 4003 is a bad ticket (never retried), 4001 with a reason is a computer that did not boot (wait for a person), a clean 1000 is the server closing. Anything else is retried. */
export function closeMeaning(code: number, reason: string, clean: boolean): { conn: Conn; why: string } | { retry: string } {
  if (code === 4003) return { conn: "refused", why: "" };
  if (code === 4001 && reason) return { conn: "failed", why: reason };
  if (code === 1000 && clean) return { conn: "ended", why: "Your server closed the stream." };
  return { retry: code === 4001 ? "The computer is not running yet." : code === 4008 ? "The stream hit a protocol error." : "The connection dropped." };
}

/** The overlay's [title, detail] while the screen is not live. */
export function overText(conn: Conn, name: string, why: string): [string, string] {
  switch (conn) {
    case "connecting": return [`Connecting to ${name}'s screen`, "Asking your server for a one-time ticket."];
    case "noscreen": return [`Connecting to ${name}'s screen`, why || "Your server did not hand out a screen stream. It may still be starting."];
    case "waiting": return [`Reconnecting to ${name}'s screen`, why];
    case "hidden": return ["Paused while this tab was hidden", `Glass let go of ${name}'s screen so it can rest. It reconnects when you come back.`];
    case "refused": return ["Your server refused the screen ticket", "Reload the page to ask for a new one."];
    case "ended": return [`${name}'s screen closed`, why];
    case "error": return [`Could not open ${name}'s screen`, why];
    case "failed": return [`${name}'s computer did not start`, `${why}. Restart the computer from ${name}'s page, then retry. If it fails again, your server's log says why.`];
    default: return ["", ""];
  }
}
export const badgeWord = (c: Conn): string => (c === "live" ? "Live" : c === "hidden" ? "Paused" : c === "refused" || c === "error" || c === "ended" || c === "failed" ? "Offline" : "Connecting");

// ---- take-over ----

export const mine = (h: Holder | null, surface: string): boolean => Boolean(h && h.surface === surface);
export const other = (h: Holder | null, surface: string): boolean => Boolean(h && h.surface !== surface);

/** Why a take-over is not offered right now, or "" when it is. */
export function whyBlocked(h: Holder | null, surface: string, live: boolean): string {
  if (other(h, surface)) return `${yourDevice(h!.surface)} has control.`;
  return live ? "" : "The screen is not connected.";
}

/** The rows beside the screen while this surface holds the keyboard: where the keystrokes go. [what, where, on]. */
export function holdingRows(name: string, priv: boolean): [string, string, boolean][] {
  return priv
    ? [[`The page on ${name}'s screen`, "receives it", true], [`${name}'s hands and eyes`, "stopped", false], [`${name}'s thread`, "never", false], ["Memory", "never", false], ["Other viewers", "no input", false]]
    : [[`The page on ${name}'s screen`, "receives it", true], [`${name}'s hands`, "paused", false], [`${name}'s Chrome link`, "stays open", false], ["Other viewers", "no input", false]];
}
export const holdingTitle = (name: string, priv: boolean): string => (priv ? "What you type goes to the page. Nowhere else." : `${name} is paused while you drive.`);

export function handedBackLine(p: { reason?: string; why?: string; idle_ms?: number; device?: string; surface?: string }, agent: string, surface: string): string {
  const from = p.device ? ` (from ${p.device})` : "";
  const r = p.reason || p.why || "";
  switch (r) {
    case "idle": return `Handed back to ${agent} after ${Math.round(Number(p.idle_ms) / 60_000)} min idle.`;
    case "chat": return `Your take-over ended when the thread moved to chat${from}.`;
    case "released": return `Your take-over ended when the thread's lease was released${from}.`;
    case "expired": return `Your take-over lapsed after 90 s without a signal${from}.`;
    default: return p.surface === surface ? `You handed back to ${agent}.` : `The keyboard went back to ${agent}.`;
  }
}

/** The one log line for a Glass event, or "" for one that only changes state. `payload.surface` is who did it. */
export function eventLine(type: string, p: Record<string, unknown>, name: string, surface: string): string {
  const who = p.surface === surface ? "You" : yourDevice(p.surface as string);
  switch (type) {
    case "computer.taken-over": case "glass.taken": return `${who} took the keyboard${p.private ? " to sign in privately" : ""}.`;
    case "computer.handed-back": case "glass.released": return handedBackLine(p as never, name, surface);
    case "computer.shielded": return p.reason === "fill" ? `The Vault is signing ${name} in; ${name} cannot see the page until it is done.` : `${name} cannot see the page while someone signs in.`;
    case "computer.unshielded": return `${name} can see the page again${p.origin ? ` (${p.origin})` : ""}.`;
    case "glass.opened": return p.surface !== surface ? `Someone started watching from ${surfaceKind(p.surface as string)}.` : "";
    default: return "";
  }
}
/** A take-over arrives twice (computer.taken-over and glass.taken): the same line within 3 s is one. */
export const isRepeat = (last: { text: string; at: number }, text: string, now: number): boolean => text === last.text && now - last.at < 3000;

/** The event's computer: payload.agent, else the name in a "computer:<name>" target. */
export const agentOf = (p: Record<string, unknown> | undefined): string | null => (str(p?.agent) || (str(p?.target).startsWith("computer:") ? str(p?.target).slice(9) : null));

export const LIFECYCLE = ["computer.created", "computer.checked-out", "computer.thawed", "computer.frozen", "computer.stopped"];
export const EVENTS = ["computer.taken-over", "computer.handed-back", "computer.idle-warning", "computer.shielded", "computer.unshielded", "glass.opened", "glass.closed", "glass.taken", "glass.released", ...LIFECYCLE];

export function stateLine(name: string, state: string): string {
  if (state === "working") return `${name} is working. You are watching live; nothing you do here reaches the screen until you take over.`;
  if (state === "frozen" || state === "idle") return `${name}'s computer is ${state}. Watching keeps it awake.`;
  return `Watching ${name}'s screen. Nothing you do here reaches it until you take over.`;
}
export const watchersLine = (viewers: number): string => { const o = Math.max(0, viewers - 1); return o === 0 ? "Only you are watching" : `You and ${o} other${o === 1 ? "" : "s"} are watching`; };

// ---- files ----

export type Entry = { name: string; kind: string; size: number | null; mtime: number | null };
export const join = (...parts: string[]): string => parts.filter(Boolean).join("/").replace(/\/+/g, "/");
export const parent = (p: string): string => p.split("/").slice(0, -1).join("/");
export const leaf = (p: string): string => p.split("/").pop() || "";
export const crumbs = (path: string): { label: string; to: string }[] => (path ? path.split("/") : []).map((seg, i, a) => ({ label: seg, to: a.slice(0, i + 1).join("/") }));

/** glass.files.list: the folder's path and its entries, folders first then by name. */
export function pickList(d: unknown): { path: string; entries: Entry[] } {
  const o = d as { path?: unknown; entries?: unknown } | null;
  const entries = (Array.isArray(o?.entries) ? o!.entries as Record<string, unknown>[] : []).filter((e) => e && typeof e.name === "string")
    .map((e) => ({ name: e.name as string, kind: str(e.kind) || "file", size: num(e.size), mtime: num(e.mtime) }));
  entries.sort((a, b) => (a.kind === "dir" ? 0 : 1) - (b.kind === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
  return { path: str(o?.path), entries };
}
export type Preview = { kind: "text"; text: string; truncated: boolean } | { kind: "image"; path: string } | { kind: "pdf" } | { kind: "none" };
export function pickPreview(d: unknown): Preview {
  const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
  if (o.kind === "text") return { kind: "text", text: str(o.text), truncated: o.truncated === true };
  if (o.kind === "image" && str(o.path).startsWith("/")) return { kind: "image", path: str(o.path) };
  if (o.kind === "pdf") return { kind: "pdf" };
  return { kind: "none" };
}
/** The raw route's address for a ticket path: only a path on the box, never another host. */
export const rawUrl = (origin: string, path: string): string | null => (path.startsWith("/") && !path.startsWith("//") ? origin + path : null);
/** The folders a dropped or picked set of files needs first, shortest first, each once. */
export function foldersFor(into: string, rels: string[]): string[] {
  const out: string[] = [];
  for (const rel of rels) {
    const parts = parent(rel).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) { const d = join(into, parts.slice(0, i).join("/")); if (!out.includes(d)) out.push(d); }
  }
  return out;
}
/** The summary after an upload. */
export const uploadedLine = (names: string[], bytes: number, into: string, root: string): string => `Uploaded ${names.length === 1 ? names[0] : `${names.length} files`} (${size(bytes)}) to ${into || root}.`;
export const rootLabel = (target: string, name: string): string => (target === "box" ? "Your server" : `${name}'s home`);
export const NO_PREVIEW = "No preview for this kind of file. Download it to open it.";
