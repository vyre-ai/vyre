// @ts-check
// "Your server has been offline since 14:02": what the owner reads when the app cannot reach its server, instead of a screen that hangs (always-online, 9 Oct). Pure, so Node tests it.
// It is built from what the app already knows (state/connection.ts: the connection status and when the server last answered); no relay change is needed.

/** How long the server has been silent before the app says so: a blip that heals in a moment shows nothing. */
export const OFFLINE_AFTER_MS = 60_000;

/** @param {number} ms @param {(d: Date) => string} [fmt] */
export const clock = (ms, fmt) => (fmt ? fmt(new Date(ms)) : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }));

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
