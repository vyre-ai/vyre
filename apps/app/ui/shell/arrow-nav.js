// @ts-check
// Up and Down move the focus between the rows of a list (web). The rows are the container's buttons and links that are not disabled; Home and End go to the ends. Pure of React so the rule can be tested.

/** The index to focus for a key, from the focused index among `count` rows, or null for a key this does not use. @param {string} key @param {number} at @param {number} count */
export function arrowTarget(key, at, count) {
  if (count <= 0) return null;
  if (key === "ArrowDown") return at < 0 ? 0 : Math.min(count - 1, at + 1);
  if (key === "ArrowUp") return at < 0 ? count - 1 : Math.max(0, at - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
