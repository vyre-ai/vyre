// @ts-check
// scrub — a first-pass content scan for a session file arriving through sync.upload, before its
// final rename lands it where Recall can read it (e2e, session-import review: "scrub at ingest").
//
// This is not a redactor: a chat transcript's meaning depends on its exact words, and cutting a
// match out of the middle would corrupt what memory-iq reads. A file that scores unsafe is
// quarantined whole (core/sync), for the person to look at, never silently dropped and
// never partly indexed.

/** Known secret token shapes, checked against the file's raw text. Labels only are ever reported. */
const PATTERNS = [
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /\bsk-[A-Za-z0-9]{20,}/],
  ["github token", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/],
  ["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["private key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["stripe key", /\bsk_live_[A-Za-z0-9]{20,}/],
];

/**
 * Scan text for known secret shapes. Bounded: stops at MAX_FOUND matches and MAX_BYTES read, so
 * one huge session file cannot make ingest slow.
 * @param {string} text @param {{ maxFound?: number, maxBytes?: number }} [o]
 * @returns {{ safe: boolean, found: string[] }} found: pattern labels only, never the matched text
 */
export function scanText(text, { maxFound = 5, maxBytes = 8_000_000 } = {}) {
  const s = text.length > maxBytes ? text.slice(0, maxBytes) : text;
  const found = [];
  for (const [label, re] of PATTERNS) {
    if (re.test(s)) { found.push(label); if (found.length >= maxFound) break; }
  }
  return { safe: found.length === 0, found };
}
