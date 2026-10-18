// @ts-check
// Asking to join a Space by its address: the rules, with no storage and no clock of their own. Pure. The words an asker is ever told are fixed here, so no state, count or reason leaks through them.

/** The one answer when the Space does not take requests, when it is full, when the asker is already in or already holds an invite. */
export const CLOSED_WORDS = "This Space only takes invites.";
/** The one answer for a request that is not going to be accepted: declined and expired read the same, with no reason. */
export const NOT_ACCEPTED_WORDS = "Not accepted.";
export const LIMITS = Object.freeze({
  /** open requests per Space; past it the owner is told once and asks are refused with the closed words */
  open: 20,
  /** asks per identity per hour */
  perIdentityHour: 5,
  /** how long a request stays open */
  ttlMs: 14 * 24 * 3_600_000,
  noteMax: 200,
  /** status reads per identity per minute (the app asks every five seconds) */
  statusPerMinute: 30,
  /** a declined or expired asker may ask again after this long (the same row, counted in the same caps) */
  askAgainMs: 24 * 3_600_000,
  hourMs: 3_600_000,
});

/** The note as plain text: control characters become spaces, one line, at most 200 characters. It is untrusted words from a stranger and is never read by a model or put in a card. @param {unknown} v */
export function cleanNote(v) {
  return String(typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, LIMITS.noteMax);
}

/** The state an asker is told, from the row: waiting, approved (with the invite to accept), or not accepted. Declined and expired are one answer. @param {{ state: string, invite?: string | null, created: number } | null} row @param {number} now */
export function statusFor(row, now) {
  if (!row) return { state: "none" };
  if (row.state === "approved" && row.invite) return { state: "approved", invite: row.invite };
  if (row.state === "open" && now - row.created < LIMITS.ttlMs) return { state: "waiting" };
  return { state: "not_accepted", words: NOT_ACCEPTED_WORDS };
}

/** The ids and forms the store takes. */
export const SPACE = /^spc_[a-z2-7]{12,26}$/;
export const IDENTITY = /^per_[a-z2-7]{26}$/;
export const ENTRY = /^[a-z2-7]{26}$/;
/** The invite the approver made for this person: the kernel's id, with the pin its link carries after a dot (the asker builds the join link from it). */
export const INVITE = /^inv_[0-9a-f]{32}(?:\.[A-Za-z0-9_-]{1,600})?$/;
export const NAME = /^[a-z0-9.-]{3,253}$/;
