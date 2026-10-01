// @ts-check
// Who an account is signed in as, read from the non-secret identity a provider's own login left in the account's HOME: the email and org that
// Claude Code keeps in .claude.json (oauthAccount) and the email claim in the id_token payload Codex keeps in auth.json. Only those fields
// are ever returned: the token itself is decoded for its public payload and dropped, never returned, logged or stored. A provider whose
// identity cannot be read gives null, and the confirm card says "account not identified".
//
// Run as a script (`node identity.js <provider> <home>`) it prints one JSON line, so that on a box it can run as the account's own uid
// (the HOME is 0700 to that uid and vyred cannot read it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clip = (/** @type {any} */ v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : undefined);

/** @param {string} file */
function json(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/** The public payload of a JWT, or null. @param {any} token */
function payload(token) {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); } catch { return null; }
}

/**
 * @param {string} provider @param {string} home
 * @returns {{ email?: string, org?: string } | null}
 */
export function readIdentity(provider, home) {
  let email, org;
  if (provider === "claude") {
    const c = json(path.join(home, ".claude.json")) || json(path.join(home, ".claude", ".claude.json"));
    const a = c && c.oauthAccount;
    if (a) { email = clip(a.emailAddress); org = clip(a.organizationName); }
  } else if (provider === "codex") {
    const a = json(path.join(home, ".codex", "auth.json"));
    const p = a && a.tokens ? payload(a.tokens.id_token) : null;
    if (p) email = clip(p.email);
  }
  return email || org ? { ...(email ? { email } : {}), ...(org ? { org } : {}) } : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = readIdentity(String(process.argv[2] || ""), String(process.argv[3] || ""));
  process.stdout.write(JSON.stringify(r) + "\n");
}
