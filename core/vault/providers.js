// @ts-check
// providers: the catalog of services a module may need a credential for (ADR 0028, decision 9a).
//
// Pure data and small helpers. Each provider says which item kinds hold its credential, how a
// person gives it (`field`: typed or pasted; `file`: a dropped JSON file; `oauth`: a sign-in flow
// another module runs), the fields to ask for, what it can do, and where a person gets the key.
// Names match credential-shapes.js's provider words where they exist. Patterns are loose shape checks, so a
// key pasted into the wrong box is caught; credential-shapes.js still decides what a value looks like.
// Nothing here ever holds, prints or returns a value.

/** What a connection can do (ADR 0028, decision 9b). Fixed words only. */
export const CAPABILITIES = /** @type {const} */ (["send_mail", "read_mail", "calendar", "files", "send_message", "speech", "llm", "search", "other"]);

/**
 * @typedef {{ name: string, label: string, secret: boolean, pattern?: string, optional?: boolean }} Field
 * @typedef {{ name: string, label: string, kinds: string[], how: "field"|"file"|"oauth", fields: Field[],
 *   capabilities: string[], pick?: boolean, help: string|null, next?: { tool: string, input?: Record<string, string> } }} Provider
 */

import { valuePattern } from "../../lib/credential-shapes.js";

const key = (label, pattern) => ({ name: "value", label, secret: true, ...(pattern ? { pattern } : {}) });

/** @type {Provider[]} */
const LIST = [
  { name: "deepgram", label: "Deepgram", kinds: ["api-key"], how: "field", fields: [key("API key")],
    capabilities: ["speech"], help: "https://console.deepgram.com/" },
  { name: "openai", label: "OpenAI", kinds: ["api-key"], how: "field", fields: [key("API key", "^sk-[A-Za-z0-9_-]{20,}$")],
    capabilities: ["llm", "speech"], help: "https://platform.openai.com/api-keys" },
  { name: "elevenlabs", label: "ElevenLabs", kinds: ["api-key"], how: "field", fields: [key("API key")],
    capabilities: ["speech"], help: "https://elevenlabs.io/app/settings/api-keys" },
  { name: "anthropic", label: "Anthropic", kinds: ["api-key"], how: "field", fields: [key("API key", valuePattern("anthropic"))],
    capabilities: ["llm"], help: "https://console.anthropic.com/settings/keys" },
  { name: "claude-setup-token", label: "Claude setup token", kinds: ["oauth"], how: "field",
    fields: [{ name: "token", label: "Token from claude setup-token", secret: true, pattern: valuePattern("anthropic-oat") }],
    capabilities: ["llm"], help: "https://docs.anthropic.com/en/docs/claude-code/cli-reference" },
  { name: "github", label: "GitHub (paste a token)", kinds: ["pat"], how: "field",
    fields: [{ name: "token", label: "Personal access token", secret: true, pattern: valuePattern("github", "github-2") }],
    capabilities: ["files", "other"], help: "https://github.com/settings/tokens" },
  { name: "github-oauth", label: "GitHub (sign in)", kinds: ["pat"], how: "oauth", fields: [],
    capabilities: ["files", "other"], help: "https://github.com/settings/connections/applications", next: { tool: "github.connect", input: { name: "" } } },
  { name: "cloudflare", label: "Cloudflare", kinds: ["api-key"], how: "field", fields: [key("API token", "^[A-Za-z0-9_-]{30,}$")],
    capabilities: ["other"], help: "https://dash.cloudflare.com/profile/api-tokens" },
  { name: "tailscale", label: "Tailscale", kinds: ["api-key"], how: "field", fields: [key("API key", "^tskey-[A-Za-z0-9-]{10,}$")],
    capabilities: ["other"], help: "https://login.tailscale.com/admin/settings/keys" },
  { name: "twilio", label: "Twilio", kinds: ["api-key"], how: "field",
    fields: [key("Auth token", "^[A-Za-z0-9]{32}$"), { name: "sid", label: "API key id (only if you sign in with an API key; it starts with SK)", secret: false, optional: true, pattern: "^SK[0-9a-f]{32}$" }],
    capabilities: ["send_message"], help: "https://console.twilio.com/" },
  { name: "telegram", label: "Telegram bot", kinds: ["api-key"], how: "field", fields: [key("Bot token", "^\\d{6,12}:[A-Za-z0-9_-]{30,}$")],
    capabilities: ["send_message"], help: "https://t.me/BotFather" },
  { name: "google-oauth", label: "Google (sign in)", kinds: ["oauth"], how: "oauth", fields: [],
    capabilities: ["send_mail", "read_mail", "calendar", "files"], help: "https://console.cloud.google.com/apis/credentials", next: { tool: "google.connect", input: { name: "" } } },
  { name: "google-dwd", label: "Google service account", kinds: ["cloud"], how: "file",
    fields: [{ name: "json", label: "Service-account JSON file", secret: true },
      { name: "subject", label: "Email to act as", secret: false, pattern: "^[^\\s@]{1,64}@[^\\s@]{1,255}$" },
      { name: "scopes", label: "Scopes (space or comma separated)", secret: false, optional: true, pattern: "^[\\w:./, -]{1,2000}$" }],
    capabilities: ["send_mail", "read_mail", "calendar", "files"], help: "https://console.cloud.google.com/iam-admin/serviceaccounts" },
  { name: "google-apps-script", label: "Google Apps Script web app", kinds: ["env-set"], how: "field",
    fields: [{ name: "url", label: "Web app URL", secret: false, pattern: "^https://script\\.google\\.com/(a/macros/[A-Za-z0-9.-]{1,253}/s|macros/s)/[A-Za-z0-9_-]{10,200}/exec$" },
      { name: "token", label: "Token", secret: true }],
    capabilities: ["send_mail", "read_mail"], pick: true, help: "https://script.google.com/home" },
  { name: "imap-smtp", label: "Email (IMAP and SMTP)", kinds: ["env-set"], how: "field",
    fields: [
      { name: "imap_host", label: "IMAP server", secret: false, pattern: "^[A-Za-z0-9.-]{1,253}$" },
      { name: "imap_port", label: "IMAP port", secret: false, pattern: "^\\d{1,5}$" },
      { name: "smtp_host", label: "SMTP server", secret: false, pattern: "^[A-Za-z0-9.-]{1,253}$" },
      { name: "smtp_port", label: "SMTP port", secret: false, pattern: "^\\d{1,5}$" },
      { name: "username", label: "Username", secret: false },
      { name: "password", label: "Password", secret: true },
      { name: "from", label: "From address", secret: false, optional: true, pattern: "^[^\\s@]{1,64}@[^\\s@]{1,255}$" },
      { name: "security", label: "Security (tls or starttls)", secret: false, pattern: "^(tls|starttls)$" }],
    capabilities: ["send_mail", "read_mail"], help: null },
  { name: "mcp-bearer", label: "MCP server token", kinds: ["api-key"], how: "field", fields: [key("Bearer token")],
    capabilities: ["other"], help: null },
];

/** The catalog, by name. Frozen: a caller can read it, never change it. */
export const PROVIDERS = Object.freeze(Object.fromEntries(LIST.map(p => [p.name, Object.freeze(p)])));

/** @param {string} name @returns {Provider|null} */
export const provider = name => (Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null);

/** What a surface needs to draw a form: names, labels and the secret flag. Never a pattern's value. */
export const formFields = p => (p ? p.fields.map(f => ({ name: f.name, label: f.label, secret: f.secret, ...(f.optional ? { optional: true } : {}) })) : []);

/**
 * Check fields a person gave against a provider. Returns the cleaned fields, or throws in words
 * that name the field, never its value.
 * @param {Provider} p @param {Record<string, unknown>} given
 * @returns {Record<string, string>}
 */
export function checkProviderFields(p, given) {
  if (!given || typeof given !== "object" || Array.isArray(given)) throw new Error("fields must be an object");
  const known = new Set(p.fields.map(f => f.name));
  for (const k of Object.keys(given)) if (!known.has(k)) throw new Error(`${p.label} has no field ${String(k).slice(0, 40)}; it takes ${[...known].join(", ")}`);
  /** @type {Record<string, string>} */
  const out = {};
  for (const f of p.fields) {
    const v = given[f.name];
    if (v === undefined || v === null || v === "") {
      if (!f.optional) throw new Error(`${p.label} needs ${f.label.toLowerCase()} (${f.name})`);
      continue;
    }
    if (typeof v !== "string") throw new Error(`${f.name} must be text`);
    const s = v.trim();
    if (!s && !f.optional) throw new Error(`${p.label} needs ${f.label.toLowerCase()} (${f.name})`);
    if (f.pattern && s && !new RegExp(f.pattern).test(s)) throw new Error(`${f.name} does not look like a ${p.label} ${f.label.toLowerCase()}`);
    if (s) out[f.name] = s;
  }
  return out;
}

/**
 * Check a dropped service-account JSON: it must be one, with an email and a private key. Returns
 * the account's email (a name, not a secret). Messages never quote the file.
 * @param {string} content
 */
export function checkServiceAccount(content) {
  let j;
  try { j = JSON.parse(String(content)); } catch { throw new Error("the file is not JSON; drop the key file Google gave you"); }
  if (!j || typeof j !== "object" || j.type !== "service_account") throw new Error("the file is not a service-account key (its type is not service_account)");
  if (typeof j.client_email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(j.client_email)) throw new Error("the service-account file has no client_email");
  if (typeof j.private_key !== "string" || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(j.private_key)) throw new Error("the service-account file has no private_key");
  return { email: j.client_email };
}
