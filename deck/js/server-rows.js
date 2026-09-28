// @ts-check
// Pure helpers for Settings > Server ("Move to a server", docs/design/anywhere.md, ADR 0039),
// pulled out of deck/views/settings.js the way deck/js/drive-rows.js did for Drive, so the state
// machine's formatting and gating logic has a testable surface even while the real move.* tool
// shapes (federation) and onboard.machine (anywhere) are still fixtures, not shipped tools.

import { plural } from "./fmt.js";

const PIECE_LABEL = { projects: "Projects", memory: "Memory", vault: "Vault", sessions: "Sessions" };
export const FORGET_WAIT_MS = 24 * 3600 * 1000;

/** Bytes, short form: KB under 1 MB, MB under 1 GB, GB above. @param {number} n */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  return v < 1e6 ? Math.round(v / 1e3) + " KB" : v < 1e9 ? (v / 1e6).toFixed(1) + " MB" : (v / 1e9).toFixed(1) + " GB";
}

/** A piece's own label: what the tool sends, else the well-known name, else the key itself.
 * @param {string} key @param {{ label?: string }} [v] */
export const pieceLabel = (key, v) => v?.label || PIECE_LABEL[key] || key;

/** "14 items · 2.1 GB", for the dry-run plan screen. @param {{ count?: number, bytes?: number }} v */
export const pieceLine = v => `${plural(v?.count || 0, "item")} · ${fmtBytes(v?.bytes || 0)}`;

/** The plan's total, summed across every piece. @param {Record<string, { bytes?: number }>} pieces */
export const totalBytes = pieces => Object.values(pieces || {}).reduce((n, v) => n + (v?.bytes || 0), 0);

/** A piece's live state during the copy: "Done", "Waiting", or "NN%".
 * @param {{ state?: string, pct?: number }} [v] */
export const pieceState = v => v?.state === "done" ? "Done" : v?.state === "doing" ? `${v.pct || 0}%` : "Waiting";

/** True once every piece is done (the status is ready for the person to confirm the flip).
 * @param {{ state?: string }} status */
export const readyToConfirm = status => status?.state === "ready_to_confirm";

/** The server's name to show, from whichever shape handed it over: federation.move.confirm's own
 * data right after the flip (`destination.name`), or onboard.status once machine is "device"
 * (a real server's identity isn't shaped by anywhere yet, hence the further fallbacks).
 * @param {{ destination?: { name?: string }, server?: { name?: string }, host?: string }} d */
export const destinationName = d => d?.destination?.name || d?.server?.name || d?.host || "your server";

/**
 * The 24-hour "Free up space" gate (anywhere.md's forget guard): not ready until a full day after
 * the move, so a shaky first day can still be undone by hand. Never automatic either side of it.
 * @param {number} movedAt @param {number} [now]
 * @returns {{ ready: boolean, hoursLeft: number }}
 */
export function forgetGate(movedAt, now = Date.now()) {
  const left = (movedAt || now) + FORGET_WAIT_MS - now;
  return { ready: left <= 0, hoursLeft: Math.max(1, Math.ceil(left / 3_600_000)) };
}
