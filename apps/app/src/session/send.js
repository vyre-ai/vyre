// @ts-check
// Send paints the user row at once (native bar 9), on chat's core as it is. A steer or a queued
// message the core draws itself (localSend). A plain send the core draws when the box's echo
// comes (thread.sent), so the echo is applied here now, under the composer's uuid, and the row is
// marked local: when the real echo (or the send's answer, confirmSend) names the box's uuid, the
// core adopts this row, so its key (u:<uuid>) and its place never change. dropLocal takes it
// back on a refusal.

import { applyEvent, localSend } from "../vendor/deck/chat/core/session-state.js";

/**
 * @param {import("../vendor/deck/chat/core/session-state.js").Session} s
 * @param {{ uuid: string, text: string, mode: "steer"|"queue"|null, at: number, surface: string }} m
 * @returns {string[]} the keys touched
 */
export function drawSend(s, m) {
  if (m.mode) return localSend(s, { uuid: m.uuid, text: m.text, mode: m.mode, at: m.at });
  const keys = applyEvent(s, { type: "thread.sent", at: m.at, payload: { thread: s.thread, text: m.text, uuid: m.uuid, surface: m.surface } });
  const u = s.byKey.get(s.meta.uuids.get(m.uuid) ?? "");
  if (u && u.kind === "user") u.local = true;
  return keys;
}
