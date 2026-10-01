// @ts-check
// The real-use test's pure parts (scripts/eval-realuse.mjs): question generation prompts, the checks a generated question must pass
// against the corpus text, and selection. No model call and no key here: a `Model` (scripts/lib/h2h.js) is passed in.

export const SYS_QGEN = [
  "You write test questions from one session transcript of a software team.",
  "Write up to 4 questions. Each asks for ONE specific fact the text states: a name, number, id, version, port, path, branch, count, date, or a decision with its reason.",
  "The answer is a short exact string copied from the text. The question must make sense on its own (name the project, tool or branch it is about; never say \"the session\", \"the transcript\", \"above\" or \"earlier\"), and must not contain the answer.",
  "Skip anything vague, any instruction to do something, and anything that is not stated as a plain fact.",
  "Output only JSON: [{\"q\": \"...\", \"expect\": [\"exact string copied from the text\"]}]",
].join(" ");

const norm = (/** @type {string} */ s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
const COMMON = new Set("the and for with that this from yes no true false none null ok done and are was you your all any one two".split(" "));

/** The text of a session as the arms see it. @param {{ turns: { role: string, text: string }[] }} s */
export const textOfSession = s => s.turns.map(t => `${t.role}: ${t.text}`).join("\n");

/** Parse a model's reply into candidate questions; anything that is not the asked JSON gives []. @param {string} text */
export function parseQuestions(text) {
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const a = JSON.parse(m[0]);
    return Array.isArray(a) ? a.filter(x => x && typeof x.q === "string" && Array.isArray(x.expect)).map(x => ({ q: x.q.trim(), expect: x.expect.map((/** @type {any} */ e) => String(e).trim()).filter(Boolean) })) : [];
  } catch { return []; }
}

/**
 * Keep a candidate only when it is a real, specific, single-source question: every expected string is in the session's own text, is 3 to 80
 * characters and not a common word, the question does not contain it and does not point at "the session", and the string appears in at most
 * two sessions of the corpus (a fact one place states, not boilerplate).
 * @param {{ q: string, expect: string[] }} c @param {string} own the session's text @param {string[]} all every session's text
 */
export function acceptable(c, own, all) {
  if (c.q.length < 15 || c.q.length > 220 || !c.expect.length || c.expect.length > 3) return false;
  if (/\b(the session|the transcript|above|earlier|previous(ly)? mentioned|this conversation)\b/i.test(c.q)) return false;
  const o = norm(own), q = norm(c.q);
  return c.expect.every(e => {
    const n = norm(e);
    if (n.length < 3 || n.length > 80 || COMMON.has(n) || q.includes(n)) return false;
    if (!o.includes(n)) return false;
    return all.filter(t => norm(t).includes(n)).length <= 2;
  });
}

/** Generate questions, one model call per session, and keep up to `want` spread across sessions. @param {import("./h2h.js").Model} model @param {{ id: string, turns: any[] }[]} sessions @param {number} want */
export async function generateQuestions(model, sessions, want = 50) {
  const texts = sessions.map(textOfSession);
  /** @type {{ q: string, expect: string[], session: string }[][]} */ const per = [];
  for (let i = 0; i < sessions.length; i++) {
    const r = await model.call({ arm: "qgen", kind: "qgen", system: SYS_QGEN, prompt: texts[i].slice(0, 14_000), maxTokens: 700 });
    per.push(parseQuestions(r.text).filter(c => acceptable(c, texts[i], texts)).map(c => ({ ...c, session: sessions[i].id })));
  }
  // Round-robin so one session cannot fill the set.
  const out = [], seen = new Set();
  for (let k = 0; out.length < want; k++) {
    let any = false;
    for (const list of per) if (list[k]) { any = true; const key = norm(list[k].q); if (!seen.has(key) && out.length < want) { seen.add(key); out.push({ ...list[k], class: "history" }); } }
    if (!any) break;
  }
  return out;
}
