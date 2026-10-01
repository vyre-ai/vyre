// @ts-check
// A message that may echo what the person typed (a pasted token) is shown with known secret shapes masked, in case the
// box or a vendor ever repeats it. The box redacts too; this is the Deck's own last check on text it draws.

const SHAPES = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:rq_live|pk_live|sk_live|rk_live)_[A-Za-z0-9]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

/** The text with token-shaped runs replaced by "[hidden]". @param {any} text @param {string[]} [also] exact strings to hide too (what was just typed) */
export function redact(text, also = []) {
  let s = String(text ?? "");
  for (const x of also) if (typeof x === "string" && x.length >= 6) s = s.split(x).join("[hidden]");
  for (const re of SHAPES) s = s.replace(re, m => (/^Bearer/i.test(m) ? "Bearer [hidden]" : "[hidden]"));
  return s;
}
