// @ts-check
// The Chat list, stale while revalidate (the pattern Home uses, ui/tasks/world-cache.js): the last list work.chat.list gave is kept on this device per Space, so Chat opens from it at once and the
// box's answer replaces it in place. Pure: the hook is src/state/chats.ts. A row is what the list already draws (titles, who, when, the last line), never a message.

/** A kept list older than this is not shown: the box is asked fresh. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** How long the first answer may take before the list stops waiting on it: the kept list (or a quiet note) shows, and a late answer still lands when it comes. */
export const LIST_BUDGET_MS = 6000;

/** The view cache key for one Space's Chat list. @param {string | null | undefined} space */
export const chatsKey = (space) => `chats.list.${space || "home"}`;

/** The rows as plain JSON for the view cache. @param {readonly any[]} rows @param {() => number} [clock] */
export const packChats = (rows, clock = Date.now) => ({ v: 2, at: clock(), rows: [...rows] });

/**
 * The rows back from the cache, or null when there are none, they are from another version or too old.
 * @param {any} raw @param {() => number} [clock] @returns {any[] | null}
 */
export function unpackChats(raw, clock = Date.now) {
  if (!raw || typeof raw !== "object" || raw.v !== 2 || !Array.isArray(raw.rows) || !Number.isFinite(raw.at) || clock() - raw.at > MAX_AGE_MS) return null;
  const rows = raw.rows.filter((/** @type {any} */ r) => r && typeof r === "object" && typeof r.id === "string" && r.id);
  // an empty kept list is no copy at all: it must never draw "No chats yet" before the box has answered
  return rows.length ? rows : null;
}

/** The key of one Space's agents, teammates and assistant name (what the list needs besides the chats), kept so the first draw has them. @param {string | null | undefined} space */
export const auxKey = (space) => `chats.aux.${space || "home"}`;

/** How long the first draw may wait for the agents and teammates when nothing is kept. */
export const AUX_BUDGET_MS = 1200;

/** @param {{ agents: any[], people: any[], assistantName: string, assistantAgent: string }} a @param {() => number} [clock] */
export const packAux = (a, clock = Date.now) => ({ v: 1, at: clock(), agents: a.agents, people: a.people, assistantName: a.assistantName, assistantAgent: a.assistantAgent });

/** @param {any} raw @param {() => number} [clock] @returns {{ agents: any[], people: any[], assistantName: string, assistantAgent: string } | null} */
export function unpackAux(raw, clock = Date.now) {
  if (!raw || typeof raw !== "object" || raw.v !== 1 || !Array.isArray(raw.agents) || !Array.isArray(raw.people) || !Number.isFinite(raw.at) || clock() - raw.at > MAX_AGE_MS) return null;
  return { agents: raw.agents, people: raw.people, assistantName: typeof raw.assistantName === "string" ? raw.assistantName : "", assistantAgent: typeof raw.assistantAgent === "string" ? raw.assistantAgent : "" };
}

/**
 * What the Chat list draws for the Space showing. `fresh` is the box's answer for it (undefined until one lands), `kept` this device's last list for it, `failed` true when the read failed or ran past
 * its budget with nothing landed. The skeleton (from "none") shows only on the very first open, inside the budget. `note` is the quiet line under a kept list the box has not refreshed.
 * @template R
 * @param {{ fresh: R[] | "unsupported" | undefined, kept: R[] | null, failed: boolean }} i
 * @returns {{ rows: R[], from: "chats" | "unsupported" | "failed" | "none", stale: boolean, note: boolean }}
 */
export function pickChats(i) {
  const { fresh, kept, failed } = i;
  if (fresh === "unsupported") return { rows: [], from: "unsupported", stale: false, note: false };
  if (fresh) return { rows: fresh, from: "chats", stale: false, note: false };
  if (kept) return { rows: kept, from: "chats", stale: true, note: failed };
  if (failed) return { rows: [], from: "failed", stale: false, note: false };
  return { rows: [], from: "none", stale: false, note: false };
}
