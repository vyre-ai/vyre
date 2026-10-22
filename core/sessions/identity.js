// @ts-check
// Who an account is signed in as, read from the non-secret identity a provider's own login left in the account's HOME: the email and org that
// Claude Code keeps in .claude.json (oauthAccount), or, when that is absent, in its credentials file or the login keychain on this computer;
// the email claim in the id_token payload Codex keeps in auth.json; and the email Grok keeps on its auth.json entry. Only those fields
// are ever returned: a token is decoded for its public payload and dropped, never returned, logged or stored. A provider whose
// identity cannot be read gives null, and the confirm card says "account not identified".
//
// Run as a script (`node identity.js <provider> <home>`) it prints one JSON line, so that on a box it can run as the account's own uid
// (the HOME is 0700 to that uid and vyred cannot read it).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Bidi controls, zero-width and other invisible format characters are dropped: an email or org must show as it is, never reordered or hidden.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/g;
const clip = (/** @type {any} */ v) => { const t = typeof v === "string" ? v.replace(INVISIBLE, "").trim() : ""; return t ? t.slice(0, 200) : undefined; };

/** @param {string} file */
function json(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/** The public payload of a JWT, or null. @param {any} token */
function payload(token) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch { return null; }
}

/** Email, org and name only. A token, a key and any other claim are dropped. @param {any} email @param {any} org @param {any} name */
function pack(email, org, name) {
  const e = clip(email), o = clip(org), n = clip(name);
  return e || o ? { ...(e ? { email: e } : {}), ...(o ? { org: o } : {}), ...(n ? { name: n } : {}) } : null;
}

/** Public email claims of a JWT, or null. The token string is never kept. @param {any} token */
function fromToken(token) {
  const p = payload(token);
  if (!p) return null;
  return pack(p.email, p.org || p.organization || p.organizationName, p.name || p.preferred_username);
}

/**
 * The non-secret identity on one login record. Explicit email and org win. Otherwise the public payload of a token
 * the record holds, and that token is dropped. @param {any} e
 * @returns {{ email?: string, org?: string, name?: string } | null}
 */
export function identityOfRecord(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  return pack(e.email || e.emailAddress, e.org || e.organizationName || e.organization || e.team, e.name || e.displayName || e.display_name)
    || fromToken(e.id_token) || fromToken(e.accessToken) || fromToken(e.access_token) || fromToken(e.key);
}

/** @param {string} home */
function claudeIdentity(home) {
  const c = json(path.join(home, ".claude.json")) || json(path.join(home, ".claude", ".claude.json"));
  const fromAccount = c && identityOfRecord(c.oauthAccount);
  if (fromAccount) return fromAccount;
  // Claude on this computer keeps the login beside .claude.json, or in the login keychain, and does not always write oauthAccount.
  for (const rel of [".claude/.credentials.json", ".claude/credentials.json", ".credentials.json"]) {
    const d = json(path.join(home, rel));
    const r = d && (identityOfRecord(d.claudeAiOauth) || identityOfRecord(d.oauthAccount));
    if (r) return r;
  }
  return keychainClaude();
}

/** The login keychain item Claude Code uses on this computer, when the files have no identity. Tests never open it. @returns {{ email?: string, org?: string, name?: string } | null} */
function keychainClaude() {
  if (process.platform !== "darwin") return null;
  if (process.argv.some((a) => a.endsWith(".test.js") || a.includes("node:test"))) return null;
  try {
    const raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] });
    const d = JSON.parse(String(raw || ""));
    return identityOfRecord(d && d.claudeAiOauth) || identityOfRecord(d && d.oauthAccount);
  } catch { return null; }
}

/** @param {string} home */
function grokIdentity(home) {
  const d = json(path.join(home, ".grok", "auth.json"));
  if (!d || typeof d !== "object") return null;
  for (const v of Object.values(d)) { const r = identityOfRecord(v); if (r) return r; }
  return identityOfRecord(d);
}

/**
 * @param {string} provider @param {string} home
 * @returns {{ email?: string, org?: string, name?: string } | null}
 */
export function readIdentity(provider, home) {
  if (provider === "claude") return claudeIdentity(home);
  if (provider === "codex") {
    const a = json(path.join(home, ".codex", "auth.json"));
    const p = a && a.tokens ? payload(a.tokens.id_token) : null;
    return p ? pack(p.email, null, p.name) : null;
  }
  if (provider === "grok") return grokIdentity(home);
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = readIdentity(String(process.argv[2] || ""), String(process.argv[3] || ""));
  process.stdout.write(JSON.stringify(r) + "\n");
}
