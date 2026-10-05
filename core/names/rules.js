// @ts-check
// The name rules both sides use: what a name may be, which addresses may be published, and the
// two hashes the box and the directory agree on. names/worker/index.js repeats these with WebCrypto
// (a Worker cannot load node:crypto); names/worker/worker.test.js checks the two match.

import crypto from "node:crypto";

export const ZONE_TAG = "vyre-acme-zone";

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

/** Words no one gets: the old list, then ours, surfaces and teams, then account-shaped words. */
export const RESERVED = new Set([
  "www", "api", "app", "admin", "mail", "docs", "status", "blog", "help", "support", "deck", "vyre",
  "root", "ns1", "ns2", "dev", "staging", "test", "download", "install", "login", "auth", "directory",
  "relay", "setup", "phone", "acme", "names", "team", "account", "secure", "billing", "signin", "signup",
  "password", "verify", "update", "security", "webmaster", "postmaster", "hostmaster", "abuse", "noreply", "ftp", "smtp", "imap", "pop",
  "capsule", "glass", "chat", "desktop", "mobile", "web", "surface", "artifacts", "sessions", "computers", "agent", "agents", "box", "server",
  "tailnet", "vault", "platform", "launch", "assistant", "integrator", "reviewer", "sight", "iq", "main", "lead", "nexus",
  "tailscale", "cloudflare", "letsencrypt", "zerossl", "railway",
]);
/** Brands. A hyphen-separated part that is one of these refuses the whole name. */
export const BRANDS = new Set([
  "google", "gmail", "youtube", "apple", "icloud", "microsoft", "outlook", "office", "azure", "amazon", "aws", "meta", "facebook", "instagram", "whatsapp",
  "paypal", "stripe", "venmo", "github", "gitlab", "openai", "anthropic", "claude", "chatgpt", "netflix", "twitter", "linkedin", "telegram", "signal",
  "dropbox", "slack", "zoom", "adobe", "ebay", "coinbase", "binance", "chase", "wellsfargo", "bankofamerica", "citibank", "visa", "mastercard", "amex",
  "samsung", "tesla", "spotify", "steam", "discord", "reddit", "tiktok", "yahoo", "uber", "airbnb", "shopify", "docusign", "walmart", "usps", "fedex", "irs",
]);

/** ASCII lookalikes, folded before the reserved check: rn to m, 0 to o, 1 to l, and i to l so "login" and "log1n" meet. @param {string} n */
export const fold = n => n.replace(/rn/g, "m").replace(/0/g, "o").replace(/[1i]/g, "l");
const FOLDED = new Set([...RESERVED, ...BRANDS].map(fold));
const BRAND_FOLDED = new Set([...BRANDS, "vyre"].map(fold));

/**
 * @param {unknown} raw
 * @returns {{ name: string, status: "ok"|"invalid"|"reserved", why: string|null }}
 */
export function verdict(raw) {
  const name = String(raw ?? "").trim().toLowerCase();
  const bad = why => ({ name, status: /** @type {const} */ ("invalid"), why });
  if (name.length < 3) return bad("at least 3 characters");
  if (name.length > 32) return bad("at most 32 characters");
  if (name.startsWith("xn--") || name.includes("xn--")) return bad("no punycode names");
  if (name.startsWith("-") || name.endsWith("-")) return bad("no dash at the start or end");
  if (name.includes("--")) return bad("no double dashes");
  if (!NAME_RE.test(name)) return bad("letters, digits or dashes, starting with a letter");
  const forms = new Set([name, fold(name)]);
  for (const f of [...forms]) forms.add(f.replace(/-/g, ""));
  const taken = { name, status: /** @type {const} */ ("reserved"), why: "that name is reserved" };
  for (const f of forms) {
    if (FOLDED.has(fold(f))) return taken;
    for (const part of f.split("-")) if (BRAND_FOLDED.has(fold(part))) return taken;
  }
  return { name, status: "ok", why: null };
}

/**
 * Only the tailnet's own address space: 100.64.0.0/10 as A and fd7a:115c:a1e0::/48 as AAAA.
 * Anything else, private ranges, IPv4-mapped forms, zone ids and odd spellings included, is null.
 * @param {unknown} raw @returns {{ type: "A"|"AAAA", ip: string }|null}
 */
export function tailnetIp(raw) {
  const s = String(raw ?? "");
  if (/^[0-9.]+$/.test(s)) {
    const p = s.split(".");
    if (p.length !== 4 || !p.every(x => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255)) return null;
    const [a, b] = p.map(Number);
    return a === 100 && b >= 64 && b <= 127 ? { type: "A", ip: s } : null;
  }
  if (!/^[0-9a-fA-F:]+$/.test(s) || s.length > 39) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const side = h => h === "" ? [] : h.split(":");
  const head = side(halves[0]), tail = halves.length === 2 ? side(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const n = groups.map(g => parseInt(g, 16));
  if (n[0] !== 0xfd7a || n[1] !== 0x115c || n[2] !== 0xa1e0) return null;
  // Canonical text: lowercase, the longest run of zero groups as "::".
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (n[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && n[j] === 0) j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  const hex = n.map(x => x.toString(16));
  const ip = best[1] >= 2 ? `${hex.slice(0, best[0]).join(":")}::${hex.slice(best[0] + best[1]).join(":")}` : hex.join(":");
  return { type: "AAAA", ip };
}


const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** RFC 4648 base32, lowercase, no padding. @param {Uint8Array} buf */
export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The label under acme.<zone> a route's own-domain challenges go to. @param {string} route */
export const routeHash = route => base32(crypto.createHash("sha256").update(`${ZONE_TAG}\n${route}`).digest()).slice(0, 26);
