// @ts-check
// The small line on a person's message: when it was sent, in two clocks when the sender's zone differs from the viewer's ("9:00 am MYT · 9:00 pm your time", lib/time's showTimes through src/time/show.js),
// and "picked up" when the assistant took it from the queue. The sender's zone is what its frame carries (`tz`); a message without a time says only what it has.

/** @param {any} it a user row: { at?: number, tz?: string, pickedUp?: boolean } @param {(ms: number, spaceZone?: string | null) => string} line */
export function metaOf(it, line) {
  const parts = [];
  if (typeof it.at === "number" && it.at > 0) parts.push(line(it.at, it.tz ?? null));
  if (it.pickedUp) parts.push("picked up");
  return parts.length ? parts.join(" · ") : undefined;
}
