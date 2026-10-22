// @ts-check
// Whether an open chat stays in the on-device message search. A leave frame for the viewer takes it out.
// So does a membership read that says they are not in it, which is the removal that never arrives as a frame
// while the chat stays open. A join frame, or a read that lists them, lets it back. Anything else keeps the last answer.

import { isKind } from "./frame-type.js";
import { membershipHold } from "./members.js";

/**
 * @param {boolean} held
 * @param {string} viewer
 * @param {Array<{ type?: string, data?: { who?: string } }> | null | undefined} frames
 */
export function heldFromFrames(held, viewer, frames) {
  if (!viewer) return held;
  let h = held;
  for (const f of frames || []) {
    const who = String(f?.data?.who || "");
    if (who !== viewer) continue;
    if (isKind(f, "participant-left")) h = true;
    else if (isKind(f, "participant-joined")) h = false;
  }
  return h;
}

/**
 * @param {boolean} held
 * @param {{ me: string | null, got: any, err: { code?: string, message?: string } | null }} read
 */
export function heldFromRead(held, read) {
  const m = membershipHold(read.me, read.got, read.err);
  if (m === "out") return true;
  if (m === "in") return false;
  return held;
}
