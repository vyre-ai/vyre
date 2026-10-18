// @ts-check
// Where a popover opens: at the word being typed, not centred. The offset is how far along the line the trigger (@, # or /) sits, measured with the box's own font, kept inside the box so the popover
// never runs off the right edge. Pure given a `measure` for a piece of text; the composer gives it a canvas on the web and nothing elsewhere (then the popover opens at the left, as before).

/**
 * @param {string} text the whole message @param {number} at where the trigger starts
 * @param {(s: string) => number} measure the width of a piece of text on one line @param {number} room the box's inner width @param {number} popover the popover's width
 * @returns {number} the left offset, 0 when it cannot be measured
 */
export function popoverLeft(text, at, measure, room, popover) {
  if (!(room > 0) || !(popover > 0)) return 0;
  const line = String(text).slice(0, Math.max(0, at)).split("\n").pop() ?? "";
  let w = 0;
  try { w = measure(line); } catch { return 0; }
  if (!Number.isFinite(w) || w <= 0) return 0;
  // a long line wraps: what is left of the last row is the offset
  if (w > room) w = w % room;
  return Math.round(Math.max(0, Math.min(w, room - popover)));
}
