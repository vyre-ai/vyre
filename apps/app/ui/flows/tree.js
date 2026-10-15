// @ts-check
// Steps in a tree: an If has a Then lane and an Else lane, a For each has one lane, Side by side has several. These are the pure helpers the builder uses to walk, change, move and remove steps at any depth.
// A lane is named by its parent step's id and a key: "then", "else", "steps" (For each), "lane:<n>" (Side by side) or "on_fail" (the steps to run if the step fails). The top of the Flow is the lane with no parent.

/** @typedef {{ id: string, kind: string, [k: string]: any }} Step */
/** @typedef {{ parent: string | null, key: string }} LaneRef */

/** The lanes a step holds, in the order they are drawn. @param {Step} s @returns {{ key: string, label: string }[]} */
export function lanesOf(s) {
  /** @type {{ key: string, label: string }[]} */ let own = [];
  if (s.kind === "decide") own = [{ key: "then", label: "Then" }, { key: "else", label: "Else" }];
  else if (s.kind === "repeat") own = [{ key: "steps", label: "For each" }];
  else if (s.kind === "parallel") own = (s.lanes || []).map((/** @type {any} */ _l, /** @type {number} */ i) => ({ key: `lane:${i}`, label: `Side ${i + 1}` }));
  return s.on_fail ? [...own, { key: "on_fail", label: "If this fails" }] : own;
}

/** @param {Step} s @param {string} key @returns {Step[]} */
export function laneSteps(s, key) {
  if (key === "on_fail") return (s.on_fail && s.on_fail.steps) || [];
  if (key.startsWith("lane:")) return (s.lanes && s.lanes[Number(key.slice(5))] && s.lanes[Number(key.slice(5))].steps) || [];
  return s[key] || [];
}

/** @param {Step} s @param {string} key @param {Step[]} steps @returns {Step} */
export function withLane(s, key, steps) {
  if (key === "on_fail") return { ...s, on_fail: { ...(s.on_fail || {}), steps } };
  if (key.startsWith("lane:")) { const i = Number(key.slice(5)); return { ...s, lanes: (s.lanes || []).map((/** @type {any} */ l, /** @type {number} */ j) => (j === i ? { ...l, steps } : l)) }; }
  return { ...s, [key]: steps };
}

/** Every step, in the order the Flow reads, at any depth. @param {Step[]} steps @param {(s: Step, depth: number) => void} fn @param {number} [depth] */
export function eachStep(steps, fn, depth = 0) {
  for (const s of steps) { fn(s, depth); for (const l of lanesOf(s)) eachStep(laneSteps(s, l.key), fn, depth + 1); }
}

/** @param {Step[]} steps @returns {Step[]} */
export const flat = (steps) => { const out = /** @type {Step[]} */ ([]); eachStep(steps, (s) => out.push(s)); return out; };

/** @param {Step[]} steps @param {string} id @returns {Step | undefined} */
export const findStep = (steps, id) => flat(steps).find((s) => s.id === id);

/** Change one step wherever it is. @param {Step[]} steps @param {string} id @param {(s: Step) => Step} f @returns {Step[]} */
export function mapStep(steps, id, f) {
  return steps.map((s) => {
    if (s.id === id) return f(s);
    let n = s;
    for (const l of lanesOf(s)) { const inner = laneSteps(s, l.key), next = mapStep(inner, id, f); if (next.some((x, i) => x !== inner[i])) n = withLane(n, l.key, next); }
    return n;
  });
}

/** The lane (and index) a step is in. @param {Step[]} steps @param {string} id @param {string | null} [parent] @returns {{ lane: LaneRef, index: number } | null} */
export function locate(steps, id, parent = null) {
  const i = steps.findIndex((s) => s.id === id);
  if (i >= 0) return { lane: { parent, key: "" }, index: i };
  for (const s of steps) for (const l of lanesOf(s)) { const r = locate(laneSteps(s, l.key), id, s.id); if (r) return r.lane.key ? r : { lane: { parent: s.id, key: l.key }, index: r.index }; }
  return null;
}

/** The steps of a lane. @param {Step[]} steps @param {LaneRef} ref @returns {Step[]} */
export const stepsIn = (steps, ref) => (ref.parent === null ? steps : laneSteps(findStep(steps, ref.parent) || { id: "", kind: "" }, ref.key));

/** Replace a lane's steps. @param {Step[]} steps @param {LaneRef} ref @param {(list: Step[]) => Step[]} f @returns {Step[]} */
export function editLane(steps, ref, f) {
  if (ref.parent === null) return f(steps);
  return mapStep(steps, ref.parent, (p) => withLane(p, ref.key, f(laneSteps(p, ref.key))));
}

/** @param {Step[]} steps @param {LaneRef} ref @param {Step} step */
export const addTo = (steps, ref, step) => editLane(steps, ref, (l) => [...l, step]);

/** Remove a step, and anything that pointed at it points at what started the Flow. @param {Step[]} steps @param {string} id @returns {Step[]} */
export function removeDeep(steps, id) {
  const here = locate(steps, id);
  if (!here) return steps;
  const gone = editLane(steps, here.lane.parent === null ? { parent: null, key: "" } : here.lane, (l) => l.filter((s) => s.id !== id));
  const rewrite = (/** @type {Step[]} */ list) => list.map((s) => {
    let n = { ...s };
    for (const k of ["link", "record"]) if (n[k] === id) n[k] = "trigger";
    for (const l of lanesOf(n)) n = withLane(n, l.key, rewrite(laneSteps(n, l.key)));
    return n;
  });
  return rewrite(gone);
}

/** Move a step up or down inside its own lane. @param {Step[]} steps @param {string} id @param {number} dir @returns {Step[]} */
export function moveDeep(steps, id, dir) {
  const here = locate(steps, id);
  if (!here) return steps;
  return editLane(steps, here.lane, (l) => { const i = l.findIndex((s) => s.id === id), j = i + dir; if (i < 0 || j < 0 || j >= l.length) return l; const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n; });
}

/** Whether a step can move up or down in its lane. @param {Step[]} steps @param {string} id @returns {{ up: boolean, down: boolean }} */
export function canMove(steps, id) {
  const here = locate(steps, id);
  if (!here) return { up: false, down: false };
  const l = stepsIn(steps, here.lane);
  return { up: here.index > 0, down: here.index < l.length - 1 };
}
