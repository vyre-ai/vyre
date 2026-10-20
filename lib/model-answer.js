// @ts-check
// model-answer: how a Flow's classify and extract steps read a model's answer, in ONE place. The runner (kernel/flows/runner.js) reads every answer with these, and a sign-in driver of the inference door
// (core/sessions/drivers/signin-door.js) checks its answer with the same reading before it hands it back, asking once more when it does not read. `expect` is what a step asks for:
//   { kind: "label", labels: [..] }   exactly one of the labels, nothing else
//   { kind: "json" }                  one JSON object

/** The JSON object in an answer (a ``` fence around it is allowed), or null. @param {unknown} text @returns {Record<string, any> | null} */
export function jsonAnswer(text) {
  try {
    const raw = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** The label an answer names, when it is exactly one of `labels`, else null. @param {unknown} text @param {readonly string[]} labels @returns {string | null} */
export function labelAnswer(text, labels) {
  const t = String(text ?? "").trim();
  return labels.includes(t) ? t : null;
}

/** Does this answer read as what the step asked for? No `expect` means any answer reads. @param {unknown} text @param {any} expect @returns {boolean} */
export function answerReads(text, expect) {
  if (!expect || typeof expect !== "object") return true;
  if (expect.kind === "json") return jsonAnswer(text) !== null;
  if (expect.kind === "label" && Array.isArray(expect.labels)) return labelAnswer(text, expect.labels.map(String)) !== null;
  return true;
}

/** The words that ask for it, added to the instructions a sign-in driver sends (a coding agent's own habits are to explain; this asks it not to). @param {any} expect @returns {string} */
export function answerRule(expect) {
  if (!expect || typeof expect !== "object") return "";
  if (expect.kind === "json") return "Answer with ONE JSON object only: no words before or after it, no code fence.";
  if (expect.kind === "label" && Array.isArray(expect.labels)) return `Answer with exactly one of these words and nothing else: ${expect.labels.map(String).join(", ")}.`;
  return "";
}
