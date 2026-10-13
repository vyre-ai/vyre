// @ts-check
// The Vault's Add sheet as rules: what the picker lists (the providers catalog, core/vault/providers.js, plus the kinds with no provider), which form each pick shows, and the vault.put
// (or SSH) call a filled form makes. Pure, so Node tests it. Nothing here holds or returns a value except the call it builds for the person's own Save.
import { PROVIDERS, checkServiceAccount } from "../../../../core/vault/providers.js";
import { GROUPS, PROVIDER_GROUP } from "./redesign.js";

/** The rule for a name in the vault: letters, digits, dot, dash and underscore. */
export const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** @typedef {{ id: string, group: string, label: string, blurb: string, icon: string, words: string, slug: string }} Entry */
/** @typedef {{ name: string, label: string, secret: boolean, optional?: boolean, multiline?: boolean, hint?: string }} FormField */
/** @typedef {{ id: string, title: string, how: "field"|"file"|"oauth"|"login"|"ssh"|"import", fields: FormField[], file?: { name: string, label: string }, help: string|null, signIn?: string }} Form */

/** How each catalog provider reads in the picker: the short name, one line on what it can do, an icon, search words, and the name it is saved under. A provider the catalog gains with no row here fails the test. */
const PICK = /** @type {Record<string, { label: string, blurb: string, icon: string, words?: string, slug?: string }>} */ ({
  anthropic: { label: "Anthropic", blurb: "Let agents use Claude models with your own API key.", icon: "spark", words: "claude api" },
  "claude-setup-token": { label: "Claude sign-in token", blurb: "Run Claude sessions on your Claude plan.", icon: "spark", words: "setup-token subscription" },
  openai: { label: "OpenAI", blurb: "Chat models and speech from OpenAI.", icon: "spark", words: "gpt chatgpt whisper" },
  deepgram: { label: "Deepgram", blurb: "Turn speech into text.", icon: "mic", words: "voice transcription" },
  elevenlabs: { label: "ElevenLabs", blurb: "Read text aloud in a natural voice.", icon: "mic", words: "voice speech" },
  "imap-smtp": { label: "Email account", blurb: "Read and send mail from any mailbox, by IMAP and SMTP.", icon: "mail", words: "imap smtp mailbox", slug: "mail" },
  "sending-service": { label: "Sending service", blurb: "Send mail through Resend, Mailgun, Postmark, SendGrid or SMTP.", icon: "send", words: "resend mailgun postmark sendgrid smtp", slug: "sending" },
  twilio: { label: "Twilio", blurb: "Send texts and place calls from your own number.", icon: "phone", words: "sms text voice call" },
  "google-oauth": { label: "Google (sign in)", blurb: "Mail, calendar and files for one Google account.", icon: "globe", words: "gmail calendar drive workspace", slug: "google" },
  "google-dwd": { label: "Google service account", blurb: "A key file that acts for people in your Google Workspace.", icon: "key", words: "workspace json delegation", slug: "google-service-account" },
  "google-apps-script": { label: "Google Apps Script", blurb: "Send and read mail through a web app you own.", icon: "file", words: "script web app", slug: "google-apps-script" },
  github: { label: "GitHub (token)", blurb: "Work with repositories using a personal access token.", icon: "term", words: "git pat repo", slug: "github" },
  "github-oauth": { label: "GitHub (sign in)", blurb: "Connect GitHub without making a token.", icon: "term", words: "git device", slug: "github" },
  cloudflare: { label: "Cloudflare", blurb: "Manage DNS and sites on your domains.", icon: "server", words: "dns domain" },
  tailscale: { label: "Tailscale", blurb: "Join machines to your private network.", icon: "devices", words: "vpn network" },
  "mcp-bearer": { label: "MCP server token", blurb: "Let Vyre call a tool server that asks for a bearer token.", icon: "link", words: "mcp bearer tools", slug: "mcp-server" },
  telegram: { label: "Telegram bot", blurb: "Message people and groups from a bot.", icon: "chat", words: "bot botfather chat" },
});

/** The kinds with no provider. */
const OWN = /** @type {Entry[]} */ ([
  { id: "login", group: "Logins", label: "Website login", blurb: "A site's address, username, password and one-time code.", icon: "globe", words: "password username totp 2fa site account", slug: "" },
  { id: "ssh", group: "SSH keys", label: "SSH key", blurb: "Make a key on your server, or add one you already have.", icon: "term", words: "ssh private public deploy key server", slug: "ssh-key" },
  { id: "note", group: "Secure notes", label: "Secure note", blurb: "Private text only you and the people you share it with can read.", icon: "file", words: "text memo", slug: "" },
  { id: "api-key", group: "Any API key", label: "Any API key", blurb: "A key or token from a service that is not listed here.", icon: "key", words: "token secret generic other", slug: "" },
]);

/** The last row: bringing items in from another password manager (the Import screen). */
export const IMPORT_ENTRY = /** @type {Entry} */ ({ id: "import", group: "Import", label: "Import from another password manager", blurb: "1Password, Bitwarden, Chrome, Dashlane or an .env file.", icon: "download", words: "1password bitwarden lastpass chrome csv", slug: "" });

/** Every provider row the picker has: the order written above, then any the catalog gained since. @returns {Entry[]} */
const providerEntries = () => [...new Set([...Object.keys(PICK), ...Object.keys(PROVIDERS)])].filter((n) => PROVIDERS[n]).map((n) => PROVIDERS[n]).map((p) => {
  const s = PICK[p.name];
  return { id: p.name, group: PROVIDER_GROUP[p.name] ?? "Any API key", label: s?.label ?? p.label, blurb: s?.blurb ?? "", icon: s?.icon ?? "key", words: `${p.label} ${s?.words ?? ""}`, slug: s?.slug ?? p.name };
});

/** The names in the catalog that the picker does not know how to show: a test keeps this empty. */
export const unplaced = () => Object.keys(PROVIDERS).filter((n) => !PICK[n] || !PROVIDER_GROUP[n]);

/**
 * The rows of the picker. Mine is the member's own vault (vault.me.put): no sign-in flows, which are the Space's connections, and no SSH keys or import, which are the Space vault's.
 * @param {"space"|"mine"} [scope] @returns {Entry[]}
 */
export function entriesFor(scope = "space") {
  const all = [...providerEntries(), ...OWN];
  const rows = scope === "mine" ? all.filter((e) => e.id !== "ssh" && PROVIDERS[e.id]?.how !== "oauth") : [...all, IMPORT_ENTRY];
  return rows;
}

/** Rows that match every word typed, in the label, the line, the group or the search words. @param {Entry[]} entries @param {string} q */
export function searchEntries(entries, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? entries.filter((e) => words.every((w) => `${e.label} ${e.blurb} ${e.group} ${e.words}`.toLowerCase().includes(w))) : entries;
}

/** The picker's sections in the order the list and the panel use, with the Import row last; a group with no match is left out. @param {Entry[]} entries */
export function pickerGroups(entries) {
  return [...GROUPS, "Import"].map((name) => ({ name, items: entries.filter((e) => e.group === name) })).filter((g) => g.items.length);
}

/** The name a pick starts with: lowercase, and still the person's to change. @param {Entry} e */
export const startName = (e) => e.slug;

/** A name as the vault keeps it: spaces become dashes, anything else not allowed is dropped. @param {string} typed */
export const slugOf = (typed) => typed.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 128);

/** @param {string} id @returns {Form|null} */
export function formOf(id) {
  if (id === "import") return { id, title: IMPORT_ENTRY.label, how: "import", fields: [], help: null };
  if (id === "login") return { id, title: "Website login", how: "login", help: null, fields: [
    { name: "url", label: "Web address", secret: false, optional: true, hint: "https://drive.juniper.example" },
    { name: "username", label: "Username", secret: false },
    { name: "password", label: "Password", secret: true },
    { name: "totp", label: "One-time code secret (optional)", secret: true, optional: true, hint: "The setup key a site shows next to its QR code" }] };
  if (id === "ssh") return { id, title: "SSH key", how: "ssh", help: null, fields: [] };
  if (id === "note") return { id, title: "Secure note", how: "field", help: null, fields: [{ name: "value", label: "Note", secret: true, multiline: true }] };
  if (id === "api-key") return { id, title: "Any API key", how: "field", help: null, fields: [{ name: "value", label: "API key", secret: true }] };
  const p = PROVIDERS[id];
  if (!p) return null;
  const title = PICK[id]?.label ?? p.label;
  if (p.how === "oauth") return { id, title, how: "oauth", fields: [], help: p.help, signIn: title.replace(/\s*\(sign in\)/, "") };
  const file = p.how === "file" ? p.fields.find((f) => f.name === "json") : undefined;
  return { id, title, how: p.how, help: p.help, ...(file ? { file: { name: file.name, label: file.label } } : {}),
    fields: orderFields(id, p.fields.filter((f) => f !== file)).map((f) => ({ name: f.name, label: f.optional && !(FIRST[id] ?? []).includes(f.name) ? optionalLabel(f.label) : f.label, secret: f.secret, ...(f.optional ? { optional: true } : {}) })) };
}

/** Fields a provider's own console shows first, in its order, even where the catalog marks one optional (Twilio: account number, auth token, the number texts come from). The rest follow, required before optional. @type {Record<string, string[]>} */
const FIRST = { twilio: ["account", "value", "from"] };

/** @typedef {{ name: string, label: string, secret: boolean, optional?: boolean }} OrderField */
/** @param {string} id @param {OrderField[]} fields @returns {OrderField[]} */
const orderFields = (id, fields) => {
  const first = FIRST[id] ?? [];
  const lead = first.map((n) => fields.find((f) => f.name === n)).filter((/** @type {OrderField | undefined} */ f) => f !== undefined);
  const rest = fields.filter((f) => !first.includes(f.name));
  return [.../** @type {OrderField[]} */ (lead), ...rest.filter((f) => !f.optional), ...rest.filter((f) => f.optional)];
};

/** "API key id (only if ...)" becomes "API key id (optional, only if ...)"; a label with no aside gets " (optional)". @param {string} l */
const optionalLabel = (l) => (/\(/.test(l) ? l.replace("(", "(optional, ") : `${l} (optional)`);

/** A field's label without its aside in brackets. @param {string} l */
const short = (l) => l.replace(/\s*\(.*$/, "").replace(/^./, (c) => c.toUpperCase());

/** What is wrong with a filled form, by field, in words the person can act on. A secret's value is never in the words. @param {Form} f @param {string} name @param {Record<string, string>} v @param {string} [file] */
export function problemsOf(f, name, v, file = "") {
  /** @type {Record<string, string>} */ const out = {};
  if (!name.trim()) out.name = "Give it a name."; else if (!NAME_RE.test(name.trim())) out.name = "A name is letters, digits, dot, dash and underscore.";
  const p = PROVIDERS[f.id];
  if (f.file && !file) out[f.file.name] = "Drop the key file here, or choose it.";
  if (f.file && file) { try { checkServiceAccount(file); } catch (e) { out[f.file.name] = e instanceof Error ? e.message : "That file is not a service-account key."; } }
  for (const x of f.fields) {
    const got = (v[x.name] ?? "").trim();
    if (!got) { if (!x.optional) out[x.name] = `${short(x.label)} is needed.`; continue; }
    const pat = p?.fields.find((q) => q.name === x.name)?.pattern;
    if (pat && !new RegExp(pat).test(got)) out[x.name] = `The ${short(x.label).toLowerCase()} does not look right for ${f.title}. Check it and paste it again.`;
    if (f.how === "login" && x.name === "url" && !/^(?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(got)) out.url = "That is not a web address.";
  }
  return out;
}

/** The host of a link the person typed, lower case, or "". @param {string} url */
const hostOf = (url) => { const m = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i.exec(url.trim()); return m ? m[1].toLowerCase() : ""; };

/**
 * The call a filled form makes: vault.put with the kind and fields the catalog says (and the provider as a detail, so the item sits in its group). In Mine it is vault.me.put, which takes no details.
 * Null when the form needs more than a call (a sign-in, an import).
 * @param {Form} f @param {string} name @param {Record<string, string>} v @param {{ scope?: "space"|"mine", file?: string, sshMode?: "make"|"existing", sshFile?: string, description?: string }} [o]
 * @returns {{ tool: string, input: Record<string, unknown> } | { error: string } | null}
 */
export function callOf(f, name, v, o = {}) {
  if (f.how === "oauth" || f.how === "import") return null;
  const nm = name.trim();
  if (f.how === "ssh") {
    if (!NAME_RE.test(nm)) return { error: "A name is letters, digits, dot, dash and underscore." };
    if (o.sshMode === "existing") return o.sshFile?.trim() ? { tool: "vault.ssh.add", input: { name: nm, file: o.sshFile.trim() } } : { error: "Type where the key file is on your server." };
    return { tool: "vault.ssh.generate", input: { name: nm, ...(o.description?.trim() ? { description: o.description.trim() } : {}) } };
  }
  const bad = Object.values(problemsOf(f, nm, v, o.file))[0];
  if (bad) return { error: bad };
  const tool = o.scope === "mine" ? "vault.me.put" : "vault.put";
  /** @type {Record<string, string>} */ const fields = {};
  for (const x of f.fields) { const got = (v[x.name] ?? "").trim(); if (got && !(f.how === "login" && x.name === "url")) fields[x.name] = x.multiline ? (v[x.name] ?? "") : got; }
  if (f.file && o.file) fields[f.file.name] = o.file;
  if (f.how === "login") {
    const host = hostOf(v.url ?? "");
    if (host && o.scope === "mine") fields.url = v.url.trim();
    return { tool, input: { name: nm, kind: "login", fields, ...(host && o.scope !== "mine" ? { url: v.url.trim(), hosts: [host] } : {}) } };
  }
  const p = PROVIDERS[f.id];
  const kind = p ? p.kinds[0] : f.how === "field" && f.id === "note" ? "note" : "api-key";
  return { tool, input: { name: nm, kind, fields, ...(p && o.scope !== "mine" ? { details: { provider: p.name } } : {}) } };
}
