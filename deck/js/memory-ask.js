// @ts-check
// Asking Vyre Memory from the phone's Find (plans/pwa.md step 9): memory.ask { question } answers from
// the person's own past sessions and personal facts. This is the words without the DOM.
//
// memory.ask replies { answer, confidence, abstained, known, sources: [{ name?, session? }], via,
// limited?, message? }. It abstains rather than guess, and a limit reached says so in its own words.

/** Does the text read as a question worth asking Memory (not a bare keyword)? @param {string} q */
export function looksLikeQuestion(q) {
  const t = String(q || "").trim();
  return /\?$/.test(t) || (/^(who|what|when|where|why|how|which|did|do|does|is|was|were|are|can|have|has)\b/i.test(t) && t.split(/\s+/).length >= 3);
}

/**
 * One reply as what the card shows.
 * @param {any} d memory.ask's data
 * @returns {{ kind: "answer"|"unsure"|"limited", text: string, note: string, sources: string[] }}
 */
export function shapeReply(d) {
  if (d && d.limited) return { kind: "limited", text: String(d.message || "Vyre Memory has reached today's limit. Try again tomorrow."), note: "", sources: [] };
  if (!d || d.abstained || typeof d.answer !== "string" || !d.answer.trim()) {
    return { kind: "unsure", text: "Not sure yet.", note: typeof d?.known === "string" ? d.known : "", sources: [] };
  }
  const sources = (Array.isArray(d.sources) ? d.sources : []).map((/** @type {any} */ s) => String(s?.name || s?.session || "")).filter(Boolean);
  return { kind: "answer", text: d.answer.trim(), note: "", sources: [...new Set(sources)].slice(0, 6) };
}

/**
 * Ask, once. Resolves to the shaped reply or `{ error }` (the box's words, or the module missing).
 * @param {(name: string, input: any) => Promise<{ data?: any, error?: any }>} call @param {string} question
 */
export async function ask(call, question) {
  const r = await call("memory.ask", { question });
  if (r.error) return { error: r.error.missing ? "Vyre Memory is not running on this box." : String(r.error.message || r.error) };
  return shapeReply(r.data);
}
