// @ts-check
// secret-shapes: text that must never be stored or quoted by memory. PURE (no fs, no vyred), so the
// recall indexer, the site-knowledge store and Vyre for Chrome's extension share one set of rules.
import { classify } from "./secret-detect.js";

/**
 * Text that must never sit in the index, where a later memory_ask could quote it. Each rule is a
 * bearer credential or invitation: a Tailscale sign-in link (network.tailscale.login hands it to the
 * person's own session), a setup claim (`#claim=`), a pairing seed (`vyre-pc:`), a private key block.
 * Add a rule here and bump REDACT_VERSION: every turn is cleaned before it is indexed, and the turns
 * already stored are cleaned once at the next pass.
 * @type {{ name: string, re: RegExp, to: string }[]}
 */
export const REDACTIONS = [
  { name: "tailscale-link", re: /https?:\/\/login\.tailscale\.com\/\S*/gi, to: "[tailscale sign-in link removed]" },
  { name: "claim", re: /#claim=[A-Za-z0-9_-]+/g, to: "#claim=[removed]" },
  { name: "pairing-seed", re: /\bvyre-pc:[A-Za-z0-9_-]+/g, to: "vyre-pc:[removed]" },
  // A pairing ticket or setup offer: 43 base64url characters near the word (a Wink ticket, ADR 0045).
  { name: "pair-ticket", re: /\b((?:wink|ticket|pair(?:ing)?|offer)\b[^\n]{0,24}?)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gi, to: "$1[removed]" },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, to: "[private key removed]" },
];
/** Bumped when REDACTIONS or the token rule changes; a pass cleans stored turns once per version. */
export const REDACT_VERSION = "3";

// A pasted key or token, by the shapes the Vault already knows (core/vault/detect.js). Only a shape
// it names (a provider key, a token, a cloud key, a JWT, a private key, a database URL); its
// "looks random" fallback is left alone, since a commit hash or an id is not a secret.
const KNOWN = new Set(["api-key", "pat", "oauth", "cloud", "jwt", "webhook", "private-key", "db-url"]);
const TOKEN = /[^\s"'`<>()\[\]{},;]{16,512}/g;
/** One bare word: removed when it is a named secret shape (trailing punctuation kept). @param {string} w */
const word = w => {
  const tail = /[.:!?-]+$/.exec(w)?.[0] || "";
  const c = classify("", tail ? w.slice(0, -tail.length) : w);
  return c.secret && KNOWN.has(c.type) ? `[${c.provider || c.type} ${c.type} removed]${tail}` : w;
};
const tokens = (/** @type {string} */ text) => text.replace(TOKEN, w => {
  if (w[0] === "/" || w[0] === ".") return w;
  // A URL keeps its shape; each value in its query or fragment (`?api_key=sk-...`) is read as a word.
  if (/^https?:\/\//i.test(w)) return w.replace(/([?&#;=])([^?&#;=]{16,})/g, (_, d, v) => d + word(v));
  return word(w);
});

/** @param {string} text */
export const redact = text => tokens(REDACTIONS.reduce((t, r) => t.replace(r.re, r.to), String(text)));

/** Kept for the callers that named it first. @param {string} text */
export const redactLinks = redact;

