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

/**
 * The slots a step gives its task (tasks v2): a reviewer, an approver, and their instructions and Space skills, as the author wrote them (the schema has checked the shape). The kernel pins the skills and refuses what the Flow's person may not use.
 * @param {any} s the step @param {(ref: string) => Promise<any>} who a person, teammate or role reference as the kernel names it
 */
export async function slotsOf(s, who) {
  const rv = s.reviewer && typeof s.reviewer === "object" ? s.reviewer : null, ap = s.approver && typeof s.approver === "object" ? s.approver : null;
  const per = (/** @type {string} */ k) => ({ ...(rv && rv[k] ? { reviewer: rv[k] } : {}), ...(ap && ap[k] ? { approver: ap[k] } : {}) });
  return {
    ...(rv ? { reviewer: await who(rv.who) } : {}), ...(ap ? { approver: await who(ap.who) } : {}),
    ...(rv && rv.quorum === "all" ? { reviewer_quorum: "all" } : {}), ...(ap && ap.quorum === "all" ? { quorum: "all" } : {}),
    ...((rv && rv.due) || (ap && ap.due) ? { escalation: { ...(rv && rv.due ? { reviewer: { due_ms: rv.due, to: { role: String(rv.escalate_to).slice(5) } } } : {}), ...(ap && ap.due ? { approver: { due_ms: ap.due, to: { role: String(ap.escalate_to).slice(5) } } } : {}) } } : {}),
    ...(Object.keys(per("instructions")).length ? { instructions: per("instructions") } : {}), ...(Object.keys(per("skills")).length ? { skills: per("skills") } : {}),
  };
}
