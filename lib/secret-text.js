// @ts-check
// lib/secret-text: does a piece of text carry something that looks like a real credential? Pure,
// no feature state. core/files checks file NAMES before sharing a folder (safety.js); this checks
// CONTENT, for text about to leave the box (a public artifact link). High-confidence shapes only:
// a key format a vendor publishes, or a PEM private key block. No entropy guessing and no
// "password =" heuristics, because a false hit here refuses a share the person asked for.

/** @type {{ kind: string, re: RegExp }[]} */
const SHAPES = [
  { kind: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "Stripe secret key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { kind: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "OpenAI key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
];

/**
 * Every credential-shaped string in `text`, by kind and 1-based line. Never returns the match
 * itself, so a refusal can be shown and logged without repeating the secret.
 * @param {string} text
 * @returns {{ kind: string, line: number }[]}
 */
export function findSecrets(text) {
  /** @type {{ kind: string, line: number }[]} */
  const out = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const s of SHAPES) if (s.re.test(lines[i])) out.push({ kind: s.kind, line: i + 1 });
  }
  return out;
}
