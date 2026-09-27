// @ts-check
// Building a question's answer (contract 1's threads.answer `answers`): no DOM, so it is tested
// on its own. A pick is what the card holds for one question: the labels chosen, and the "Other"
// text when that row is on. Single-select: the label, or the typed text. Multi-select: the
// labels joined with ", ", the typed text last.

/** @typedef {{ question: string, header?: string, multiSelect?: boolean, options: { label: string, description?: string, preview?: string }[] }} Question */
/** @typedef {{ chosen: string[], other: boolean, text: string }} Pick */

/** @returns {Pick} */
export const emptyPick = () => ({ chosen: [], other: false, text: "" });

/**
 * Choose an option (or the "Other" row when label is null). Single-select replaces the choice;
 * multi-select toggles it. Returns a new pick.
 * @param {Question} q @param {Pick} pick @param {string|null} label
 */
export function choose(q, pick, label) {
  if (q.multiSelect) {
    if (label == null) return { ...pick, other: !pick.other };
    const has = pick.chosen.includes(label);
    return { ...pick, chosen: has ? pick.chosen.filter(l => l !== label) : [...pick.chosen, label] };
  }
  if (label == null) return { ...pick, chosen: [], other: true };
  return { ...pick, chosen: [label], other: false };
}

/** The answer text for one question, or "" when nothing is chosen yet. @param {Question} q @param {Pick} pick */
export function answerText(q, pick) {
  const typed = pick.other ? String(pick.text || "").trim() : "";
  if (q.multiSelect) {
    const order = q.options.map(o => o.label).filter(l => pick.chosen.includes(l));
    return [...order, ...(typed ? [typed] : [])].join(", ");
  }
  if (pick.other) return typed;
  return pick.chosen[0] || "";
}

/** Whether a question has an answer that can be sent. */
export const answered = (q, pick) => answerText(q, pick) !== "";

/**
 * threads.answer's `answers`: { [question text]: answer }. Throws when one is missing, so a
 * half-filled card can never send.
 * @param {Question[]} questions @param {Pick[]} picks
 */
export function buildAnswers(questions, picks) {
  /** @type {Record<string, string>} */
  const out = {};
  questions.forEach((q, i) => {
    const a = answerText(q, picks[i] || emptyPick());
    if (!a) throw new Error(`"${q.header || q.question}" has no answer yet`);
    out[q.question] = a;
  });
  return out;
}

/** The threads.answer input for a question ask. */
export function answerInput(askId, questions, picks) {
  return { ask: askId, decision: "allow", answers: buildAnswers(questions, picks), surface: "deck" };
}
