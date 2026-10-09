// @ts-check
// ask/model: the pure half of "one card for every question": checking what an agent asks, and checking a person's answers against it. No Vyre in here; the module and the card both read it.

export const MAX_QUESTIONS = 6, MAX_CHOICES = 8, MAX_TEXT = 500;

const clip = (/** @type {unknown} */ v, /** @type {number} */ n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * @typedef {{ id: string, prompt: string, choices: { label: string, detail?: string }[], allowText: boolean, optional: boolean }} Question
 * Ask for between one and six questions, each with up to eight choices and (by default) room to type or say one's own. A choice is its label, and a line under it when the agent has one ("Downloads, 2 MB").
 * @param {unknown} raw @returns {Question[]}
 */
export function cleanQuestions(raw) {
  if (!Array.isArray(raw) || !raw.length) throw Object.assign(new Error("ask at least one question"), { code: "bad_input" });
  if (raw.length > MAX_QUESTIONS) throw Object.assign(new Error(`ask at most ${MAX_QUESTIONS} questions at a time`), { code: "bad_input" });
  const seen = new Set();
  return raw.map((q, i) => {
    const o = q && typeof q === "object" ? /** @type {any} */ (q) : {};
    const prompt = clip(o.prompt ?? o.question, 300);
    if (!prompt) throw Object.assign(new Error(`question ${i + 1} needs its words`), { code: "bad_input" });
    let id = clip(o.id, 40).replace(/[^A-Za-z0-9_-]/g, "") || `q${i + 1}`;
    if (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    const choices = (Array.isArray(o.choices) ? o.choices : []).slice(0, MAX_CHOICES).map((/** @type {any} */ c) => typeof c === "string" ? { label: clip(c, 120) } : { label: clip(c && c.label, 120), ...(c && c.detail ? { detail: clip(c.detail, 160) } : {}) }).filter((/** @type {{ label: string }} */ c) => c.label);
    const allowText = o.allowText !== false && o.allow_text !== false;
    if (!choices.length && !allowText) throw Object.assign(new Error(`question ${i + 1} has no choices and no room to type`), { code: "bad_input" });
    return { id, prompt, choices, allowText, optional: o.optional === true };
  });
}

/**
 * A person's answers, checked against the questions: each is a choice (by label) or their own words; every question not marked optional needs one. Returns the clean answers, or why not.
 * @param {Question[]} questions @param {unknown} raw @returns {{ ok: true, answers: Record<string, { choice?: string, text?: string }> } | { ok: false, error: string }}
 */
export function checkAnswers(questions, raw) {
  const given = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  /** @type {Record<string, { choice?: string, text?: string }>} */ const answers = {};
  for (const q of questions) {
    const a = given[q.id];
    const choice = a && typeof a.choice === "string" ? a.choice : "";
    const text = a && typeof a.text === "string" ? clip(a.text, MAX_TEXT) : "";
    if (choice && !q.choices.some(c => c.label === choice)) return { ok: false, error: `"${choice.slice(0, 60)}" is not one of the choices for "${q.prompt.slice(0, 60)}"` };
    if (text && !q.allowText) return { ok: false, error: `"${q.prompt.slice(0, 60)}" takes a choice, not typed words` };
    if (!choice && !text) { if (q.optional) continue; return { ok: false, error: `answer "${q.prompt.slice(0, 80)}"` }; }
    answers[q.id] = text ? { text } : { choice };
  }
  return { ok: true, answers };
}

/** The answers as words an agent reads: "Is this the file? report-final.pdf. Which Sam? Sam Lee." @param {Question[]} questions @param {Record<string, { choice?: string, text?: string }>} answers */
export const answerLines = (questions, answers) => questions.filter(q => answers[q.id]).map(q => `${q.prompt} ${answers[q.id].text ?? answers[q.id].choice}`);
