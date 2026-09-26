// @ts-check
// Where Recall's index stands, as one line for `vyre status` and `vyre doctor`, from
// recall.status. Null when there is nothing in progress worth saying.

const n = x => Number(x || 0).toLocaleString("en-US");

/** @param {any} st recall.status's data */
export function progressLine(st) {
  if (!st) return null;
  const p = st.progress || {};
  const v = st.vectors || {};
  const paused = p.paused ? `, paused: ${p.paused}` : ", low priority";
  if (st.indexing && p.sessions && p.sessions.done < p.sessions.total) return `indexing ${n(p.sessions.done)} of ${n(p.sessions.total)} sessions${paused}`;
  if (typeof v.why === "string" && v.why.startsWith("downloading")) return v.why;
  if (v.on && v.pending > 0) return `search by meaning: ${n(v.embedded)} of ${n(st.turns)} turns${paused}; keyword search works now`;
  return null;
}
