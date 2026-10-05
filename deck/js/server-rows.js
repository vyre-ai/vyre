// @ts-check
// Pure helpers for Settings > Server ("Move to a server", docs/design/anywhere.md, ADR 0039),
// pulled out of deck/views/settings.js the way deck/js/drive-rows.js did for Drive, so the state
// machine's formatting and gating logic has a testable surface even while federation's real
// move.* tool is not built yet (their contract is confirmed, team/archive/work-journals/federation.md; the engine
// itself is next). onboard.machine (anywhere) is real and shipped.
//
// The status shape (`pieceState`, `readyToConfirm`) matches federation's contract exactly:
// move.status returns { stage: "copying"|"verifying"|"ready"|"confirmed"|"failed", pieces: {
// <key>: { bytes, of, done, error } } } — bytes/of for a live percent, done a per-piece
// boolean, error a string when that piece failed. No explicit "ready" event exists (federation's
// four events are move.progress/move.piece.done/move.failed/move.confirmed), so the Deck infers
// "ready to confirm" itself once every known piece is done and none has failed (allReady, below);
// move.status's own `stage` is still authoritative once a call to it is made (after start, or a
// reload), allReady only covers the gap between events with no full-status refetch.

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

/** A piece's live progress as a percent (0-100), for the meter's width. @param {{ bytes?: number, of?: number }} [v] */
export const piecePct = v => v?.of ? Math.min(100, Math.round(100 * (v.bytes || 0) / v.of)) : 0;

/** A piece's live state during the copy: "Failed", "Done", "Waiting", or "NN%".
 * @param {{ bytes?: number, of?: number, done?: boolean, error?: string }} [v] */
export const pieceState = v => v?.error ? "Failed" : v?.done ? "Done" : v?.bytes ? `${piecePct(v)}%` : "Waiting";

/** True once move.status itself says so. @param {{ stage?: string }} status */
export const readyToConfirm = status => status?.stage === "ready";

/** True once every named piece is done and none has failed — the Deck's own inference between
 * events, since federation's contract has no explicit "ready" event (only progress/piece.done/
 * failed/confirmed). @param {Record<string, { done?: boolean, error?: string }>} pieces
 * @param {string[]} keys the piece keys the plan actually named */
export const allReady = (pieces, keys) => keys.length > 0 && keys.every(k => pieces?.[k]?.done && !pieces[k].error);

/**
 * One federation move.* event, merged onto a pieces snapshot. Pulled out so it is the same
 * function whether it applies a live event or replays one buffered during the move.status round
 * trip (reviewer-2's race-window finding, 26ba1830): the watcher attaches its listener before
 * awaiting the baseline, buffers anything that arrives in between, then replays those buffered
 * events onto the baseline with this exact function before switching to live.
 * @param {Record<string, any>} pieces
 * @param {{ type: string, payload: any }} e
 */
export function mergeEvent(pieces, e) {
  if (e.type === "move.progress") return { ...pieces, [e.payload.piece]: { ...pieces[e.payload.piece], bytes: e.payload.bytes, of: e.payload.of } };
  if (e.type === "move.piece.done") return { ...pieces, [e.payload.piece]: { ...pieces[e.payload.piece], done: true, bytes: pieces[e.payload.piece]?.of } };
  if (e.type === "move.failed") return { ...pieces, [e.payload.piece]: { ...pieces[e.payload.piece], error: e.payload.error || "failed" } };
  return pieces;
}

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
