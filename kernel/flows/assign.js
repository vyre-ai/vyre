// @ts-check
// Best-suited doer: a task that names a role or a pool is given to the one candidate who fits it best, and the choice says why. Pure: the runner brings the candidates and the signals.
//
//   chooseDoer({ candidates, skills, involvement, load }) -> { pick, why, ranking } | { pick: null, why }
//
// Order: a candidate must have every skill the step asks for (none asked, everyone qualifies); then the one with the most history on THIS record (tasks already given to them on it),
// then the lightest open workload, then the order the candidates came in (so with no signals at all the first holder is chosen, as it always was).

/** @typedef {{ kind: string, id: string, space: string }} ActorRef */
/** @typedef {{ actor: ActorRef, name?: string, skills?: readonly string[] }} Candidate */

const norm = (/** @type {string} */ s) => String(s).trim().toLowerCase();
const nameOf = (/** @type {Candidate} */ c) => c.name || c.actor.id;

/**
 * @param {{ candidates: readonly Candidate[], skills?: readonly string[], involvement?: Readonly<Record<string, number>>, load?: Readonly<Record<string, number>> }} o
 */
export function chooseDoer({ candidates, skills = [], involvement = {}, load = {} }) {
  const want = skills.map(norm).filter(Boolean);
  const rows = candidates.map((c, order) => {
    const has = new Set((c.skills || []).map(norm));
    const missing = want.filter(w => !has.has(w));
    return { c, order, missing, history: involvement[c.actor.id] || 0, open: load[c.actor.id] || 0 };
  });
  const fit = rows.filter(r => r.missing.length === 0);
  if (!fit.length) return { pick: null, why: want.length ? `nobody among ${rows.length} candidate(s) has ${want.join(", ")}` : "there is nobody to choose from" };
  fit.sort((a, b) => b.history - a.history || a.open - b.open || a.order - b.order);
  const best = fit[0];
  const bits = [];
  if (want.length) bits.push(`has ${want.join(", ")}`);
  bits.push(best.history ? `has worked on this record ${best.history} time${best.history === 1 ? "" : "s"}` : "has not worked on this record yet");
  bits.push(`${best.open} open task${best.open === 1 ? "" : "s"}`);
  const why = `${nameOf(best.c)}: ${bits.join("; ")}${fit.length > 1 ? ` (chosen from ${fit.length})` : ""}`;
  return { pick: best.c, why, ranking: fit.map(r => ({ id: r.c.actor.id, history: r.history, open: r.open })) };
}
