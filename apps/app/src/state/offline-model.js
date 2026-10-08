// @ts-check
// "Your server has been offline since 14:02": what the owner reads when the app cannot reach its server, instead of a screen that hangs (always-online, 9 Oct). Pure, so Node tests it.
// It is built from what the app already knows (state/connection.ts: the connection status and when the server last answered); no relay change is needed.

import { timeOf } from "../time/show.js";

/** How long the server has been silent before the app says so: a blip that heals in a moment shows nothing. */
export const OFFLINE_AFTER_MS = 60_000;

/** The time of day, read by the one time formatter (lib/time through ../time/show.js) in the viewer's zone; a test passes its own `fmt`. @param {number} ms @param {(d: Date) => string} [fmt] */
export const clock = (ms, fmt) => (fmt ? fmt(new Date(ms)) : timeOf(ms));

/**
 * The notice, or null when there is nothing to say.
 * @param {{ status: "live" | "reconnecting" | "offline", lastSeen: number | null, now: number, fmt?: (d: Date) => string }} o
 * @returns {{ fact: string, detail: string } | null}
 */
export function offlineNotice({ status, lastSeen, now, fmt }) {
  // The device itself has no network: that is its own, older pill, and the server is not at fault.
  if (status !== "reconnecting") return null;
  if (lastSeen !== null && now - lastSeen < OFFLINE_AFTER_MS) return null;
  const fact = lastSeen !== null ? `Your server has been offline since ${clock(lastSeen, fmt)}` : "Your server is not answering";
  return { fact, detail: "Check that it is switched on and online. A Mac server that restarted may be waiting at its login window." };
}
