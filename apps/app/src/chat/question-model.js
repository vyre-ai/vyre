// @ts-check
// The pure half of the question card: what has been picked, whether Continue is ready, what is sent, and the summary line once answered. Node tests it; QuestionsCard.tsx draws it.

/** @typedef {{ id: string, prompt: string, choices: { label: string, detail?: string }[], allowText: boolean, optional: boolean }} Question */
/** @typedef {Record<string, { choice?: string, text?: string }>} Picked */

/** Pick a choice (a second tap on the same one lets it go); typing own words replaces a choice, and choosing replaces typed words. @param {Picked} p @param {string} id @param {string} label @returns {Picked} */
export function pickChoice(p, id, label) {
  const next = { ...p };
  if (p[id] && p[id].choice === label) delete next[id]; else next[id] = { choice: label };
  return next;
}
/** @param {Picked} p @param {string} id @param {string} text @returns {Picked} */
export function typeOwn(p, id, text) {
  const next = { ...p };
  if (text.trim()) next[id] = { text }; else delete next[id];
  return next;
}

/** Every question that is not optional has an answer. @param {Question[]} qs @param {Picked} p */
export const ready = (qs, p) => qs.every(q => q.optional || Boolean(p[q.id] && (p[q.id].choice || (p[q.id].text || "").trim())));

/** What goes to the box: trimmed own words, or the choice. @param {Question[]} qs @param {Picked} p @returns {Picked} */
export function toAnswers(qs, p) {
  /** @type {Picked} */ const out = {};
  for (const q of qs) { const a = p[q.id]; if (!a) continue; if (a.text && a.text.trim()) out[q.id] = { text: a.text.trim() }; else if (a.choice) out[q.id] = { choice: a.choice }; }
  return out;
}

/** How many are answered of how many (the optional ones are not counted against). @param {Question[]} qs @param {Picked} p */
export const progress = (qs, p) => { const need = qs.filter(q => !q.optional); return { done: need.filter(q => p[q.id] && (p[q.id].choice || (p[q.id].text || "").trim())).length, of: need.length }; };

/** The answered card's line for one question. @param {Question} q @param {Picked} answers */
export const answerOf = (q, answers) => (answers[q.id] ? (answers[q.id].text ?? answers[q.id].choice ?? "") : "Skipped");
