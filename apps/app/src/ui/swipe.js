// The release rule for a swiped row (needs-row.md, "The swipe is ..."), the same numbers as the
// pwa's need-rows.js on every surface. Pure, so node tests import it.

/** The commit point and the width of a revealed action, in px. */
export const ACTION_W = 100;
/** A release this fast (px per ms, toward the open side) is a fling and commits. */
export const FLING = 0.5;

/**
 * What a released swipe does. x is the row's offset (positive: dragged right), v its velocity in
 * px/ms (positive: moving right). A full reveal or a fling past 24 commits, 40 to 100 rests open
 * with the action showing, under 40 closes.
 * @param {number} x @param {number} v
 * @returns {"commit-right"|"open-right"|"commit-left"|"open-left"|"close"}
 */
export function release(x, v) {
  if (x > 0) {
    if (x >= ACTION_W || (v >= FLING && x > 24)) return "commit-right";
    return x >= ACTION_W * 0.4 ? "open-right" : "close";
  }
  if (x < 0) {
    if (-x >= ACTION_W || (-v >= FLING && -x > 24)) return "commit-left";
    return -x >= ACTION_W * 0.4 ? "open-left" : "close";
  }
  return "close";
}
