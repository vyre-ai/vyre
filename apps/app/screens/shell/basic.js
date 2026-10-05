// @ts-check
import { spaceName as spaceNameOf } from "../../src/state/space-name.js";
// A Basic personal space is one with no server (CHAT 5 Oct 03:15Z): chats and projects work as normal, but Planner, tasks, reminders, notes, Records and flows need a space on a server. On Basic those places
// say one plain line, offer the team spaces the person is in, and offer a server of their own. This file is the pure part: which space is Basic, which places are gated, and the backup line.

export const NEEDS_SERVER = "This needs a Cloud space";
export const ADD_SERVER = "Set up My Cloud";

/** Is this space row a personal space with no server? Read only from the box's `tier` field ("basic" or "cloud"); a team or joined space is always cloud. @param {{ tier?: string } | null | undefined} row */
export const isBasicRow = (row) => Boolean(row) && row?.tier === "basic";

/**
 * The places a Personal (no server) space cannot have. With no Cloud space at all (hasCloud false) that is Records (Contacts included), flows and Kits, the planner (reminders, notes, tasks) and the
 * calendar. A person who is in any Cloud space has the planner, reminders, notes, to-dos and the calendar in Personal too: those are kept encrypted on the team's server (CHAT 5 Oct 04:45Z, option B).
 * Custom Records, Customize, flows and Kits stay gated either way.
 * @param {string} path @param {boolean} [hasCloud]
 */
export function gatedPath(path, hasCloud = false) {
  if (/^\/u\/(records|record|flows|flow|kits|kit|settings\/customize)(\/|$)/.test(path)) {
    // Reminders and notes are the planner's own Records types: open to a person who has a Cloud space.
    if (hasCloud && /^\/u\/records\/(reminder|note)(\/|$)/.test(path)) return false;
    return true;
  }
  if (/^\/u\/(planner|calendar|task)(\/|$)/.test(path)) return !hasCloud;
  return false;
}

/** Where a Personal space's planner items are kept: encrypted on the team server of a Cloud space the person is in. @param {{ basic: boolean, teams: readonly { name: string }[] }} o */
export function storedLine({ basic, teams }) {
  if (!basic || !teams.length) return null;
  return `Reminders, notes and to-dos: encrypted on ${teams[0].name}'s server`;
}

/**
 * The backup line for a Personal (no server) space. The box says where it goes (memory.backup.status: { to: <space name or null>, last, state }). With no answer and no team space it is "Not backed up";
 * with no answer and a team space the box has not said, so nothing is claimed.
 * @param {{ basic: boolean, teams: readonly { name: string }[], status?: { to?: string | null, last?: number | string | null, state?: string } | null }} o
 */
export function backupLine({ basic, teams, status }) {
  if (!basic) return null;
  if (status && typeof status.to === "string" && status.to) return `Backed up, encrypted, to ${status.to}`;
  if (status && status.to === null) return "Not backed up: join a team or set up My Cloud";
  if (!teams.length) return "Not backed up: join a team or set up My Cloud";
  return null;
}

/**
 * The Cloud spaces a Personal space's planner items can be kept on, and the one they are on now: spaces.tier answers { cloud: [{ id, name, label }], personal_host }. Each is named by the one naming function.
 * @param {any} t @returns {{ options: [string, string][], current: string | null }}
 */
export function hostChoices(t) {
  const cloud = Array.isArray(t?.cloud) ? t.cloud : [];
  /** @type {[string, string][]} */ const options = cloud.filter((/** @type {any} */ c) => c && typeof c.id === "string").map((/** @type {any} */ c) => [c.id, spaceNameOf({ id: c.id, name: c.name ?? "", label: c.label ?? undefined, tier: "cloud" })]);
  const current = typeof t?.personal_host === "string" && options.some(([id]) => id === t.personal_host) ? t.personal_host : null;
  return { options, current };
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];
/** A size in words: 1.5 GB. @param {number} n */
export function sizeWords(n) {
  let v = Math.max(0, Number(n) || 0), i = 0;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${UNITS[i]}`;
}

/** The storage line for the space that keeps a Personal space's items: spaces.storage.usage answers { used, cap } in bytes (cap 0 for none). @param {any} u @param {string} host */
export function storageLine(u, host) {
  if (!u || typeof u.used !== "number") return null;
  const cap = typeof u.cap === "number" && u.cap > 0 ? ` of ${sizeWords(u.cap)}` : "";
  return `Using ${sizeWords(u.used)}${cap} on ${host}`;
}

/** The caps an owner may pick for every member, in bytes (0 is no cap); the current one is listed even when it is not one of these. @param {number} current @returns {[string, string][]} */
export function capChoices(current) {
  const GB = 1024 ** 3;
  const base = [0, 1 * GB, 5 * GB, 10 * GB, 50 * GB, 100 * GB];
  const all = base.includes(current) || !Number.isFinite(current) ? base : [...base, current].sort((a, b) => a - b);
  return all.map((n) => [String(n), n === 0 ? "No cap" : sizeWords(n)]);
}
