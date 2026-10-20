// @ts-check
// The Vault's Add sheet as rules. Three ways in: Paste from .env (env-model.js), a Blank item, and Pick an app. An app is a template only when Vyre itself declares it: a module's
// need (vault.need, its manifest's needs.credentials), the provider catalog (core/vault/providers.js), or a template this Space kept from an earlier suggestion (vault.templates).
// Any other app: the person types its name and their own AI account suggests the fields (vault.template.suggest, sent the name only); with no account, a blank item.
// AI accounts (Settings, AI accounts), app sign-ins (Connections) and three expert kinds (Advanced) are not offered here. Pure, so Node tests it. Values pass through only on
// their way to the person's own Save, byte-exact.
import { PROVIDERS } from "../../../../core/vault/providers.js";
import { NAME_RE, canonical, fieldProblems, itemCall, slugOf } from "./env-model.js";

export { NAME_RE, slugOf };

/** @typedef {import("./env-model.js").DField} DField */
/** @typedef {import("./env-model.js").Draft} Draft */
/** @typedef {{ name: string, label: string, secret: boolean, optional?: boolean, help?: string }} TField a template's field: `name` is the name it is saved under */
/**
 * @typedef {{ id: string, label: string, line: string, source: "need" | "app" | "space", provider?: string, need?: { module: string, id: string, multiple?: boolean },
 *   fields: TField[], help: string | null, extra: boolean, test?: { tool: string, asks?: string } }} Template
 *   `extra`: the person may add another field (a need's fields are the module's own and nothing else)
 */

/** A catalog provider that is an AI account: those live in Settings, AI accounts. @param {{ capabilities: readonly string[] }} p */
export const isAiAccount = (p) => p.capabilities.includes("llm");
/** A catalog provider that is an app sign-in, or a key for an app that has one: those live in Connections. @param {{ name: string, how: string }} p */
export const isSignIn = (p) => p.how === "oauth" || Object.prototype.hasOwnProperty.call(PROVIDERS, `${p.name}-oauth`);
/** Expert kinds, added from Advanced: a service-account key file, an Apps Script web app, and a bare MCP bearer token. */
export const ADVANCED_KINDS = /** @type {const} */ (["google-dwd", "google-apps-script", "mcp-bearer"]);
/** Whether the Add sheet offers a catalog provider. @param {string} name */
export function offered(name) {
  const p = Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null;
  return !!p && p.how === "field" && !isAiAccount(p) && !isSignIn(p) && !(/** @type {readonly string[]} */ (ADVANCED_KINDS)).includes(name);
}

/** A field's label without its aside (in brackets, or after a comma), capitalised. @param {string} l */
const short = (l) => String(l).replace(/\s*[(,].*$/, "").replace(/^./, (c) => c.toUpperCase());
/** A module's name as people read it. @param {string} m */
const moduleWord = (m) => String(m).replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
/** @param {{ name: string, label: string, secret: boolean, optional?: boolean }} f @returns {TField} */
const fromCatalog = (f) => ({ name: f.name, label: short(f.label), secret: f.secret, ...(f.optional ? { optional: true } : {}), ...(/\(/.test(f.label) ? { help: f.label.replace(/^[^(]*\(|\)$/g, "") } : {}) });

/**
 * @typedef {{ module: string, id: string, provider: string, purpose: string, state: string, item?: string | null, optional?: boolean, multiple?: boolean, how?: string | null,
 *   fields?: { name: string, label: string, secret: boolean, optional?: boolean }[], help?: string | null, test?: { tool: string, asks?: string } }} Need one row of vault.need
 * @typedef {{ app: string, fields: { name: string, secret: boolean, help?: string }[] }} Saved one of vault.templates
 */

/** A need's fields as vault.need gives them, else the catalog's. @param {Need} n @returns {{ name: string, label: string, secret: boolean, optional?: boolean }[]} */
const fieldsOf = (n) => (n.fields ?? /** @type {{ name: string, label: string, secret: boolean, optional?: boolean }[]} */ ([...PROVIDERS[n.provider].fields]));

/** The template for one module's need: its own fields, saved through vault.connect. @param {Need} n @returns {Template | null} */
export function needTemplate(n) {
  if (!offered(n.provider)) return null;
  const p = PROVIDERS[n.provider];
  return { id: `need:${n.module}:${n.id}`, label: `${p.label.replace(/\s*\(.*$/, "")} for ${moduleWord(n.module)}`, line: n.purpose, source: "need", provider: n.provider,
    need: { module: n.module, id: n.id, ...(n.multiple ? { multiple: true } : {}) }, fields: fieldsOf(n).map(fromCatalog), help: n.help ?? p.help, extra: false, ...(n.test ? { test: n.test } : {}) };
}

/**
 * Every app the Add sheet offers, in order: what Vyre's modules need, the catalog's apps, then this Space's own templates. Never an AI account or a sign-in.
 * @param {{ needs?: Need[], saved?: Saved[] }} [o] @returns {Template[]}
 */
export function templates({ needs = [], saved = [] } = {}) {
  /** @type {Template[]} */ const out = [];
  for (const n of needs) { const t = needTemplate(n); if (t) out.push(t); }
  for (const p of Object.values(PROVIDERS)) {
    if (!offered(p.name)) continue;
    out.push({ id: `app:${p.name}`, label: p.label.replace(/\s*\(.*$/, ""), line: `Fields for ${p.label.replace(/\s*\(.*$/, "")}`, source: "app", provider: p.name, fields: p.fields.map(fromCatalog), help: p.help, extra: true });
  }
  for (const s of saved) out.push({ id: `space:${s.app.toLowerCase()}`, label: s.app, line: "Used before in this Space", source: "space", fields: s.fields.map((f) => ({ name: canonical(f.name), label: canonical(f.name), secret: f.secret !== false, ...(f.help ? { help: f.help } : {}) })), help: null, extra: true });
  return out;
}

/** Templates whose name, line or field names hold every word typed. @param {Template[]} list @param {string} q */
export function searchTemplates(list, q) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? list.filter((t) => words.every((w) => `${t.label} ${t.line} ${t.fields.map((f) => `${f.label} ${canonical(f.name)}`).join(" ")}`.toLowerCase().includes(w))) : list;
}

let seq = 0;
const fid = () => `t${++seq}`;

/** A template as an item being added: its fields in order, required first, secret ones secret, values empty. @param {Template} t @returns {Draft} */
export function draftOf(t) {
  const fields = [...t.fields.filter((f) => !f.optional), ...t.fields.filter((f) => f.optional)];
  return { id: t.id, name: t.source === "need" ? "" : t.label, fields: fields.map((f) => ({ id: fid(), key: f.name, value: "", secret: f.secret, on: true, label: f.label, ...(f.help ? { help: f.help } : {}), ...(f.optional ? { optional: true } : {}) })) };
}

/** A blank item: one field to name. @returns {Draft} */
export const blankDraft = () => ({ id: "blank", name: "", fields: [{ id: fid(), key: "", value: "", secret: true, on: true }] });

/** One more field for "Add another field". @returns {DField} */
export const newField = () => ({ id: fid(), key: "", value: "", secret: true, on: true });

/** A suggestion (vault.template.suggest) as a draft: its fields when there are any, else a blank item named after the app. @param {{ app: string, fields: { name: string, secret: boolean, help?: string }[] }} s @returns {Draft} */
export function suggestionDraft(s) {
  if (!s.fields.length) return { ...blankDraft(), name: s.app };
  return { id: `space:${s.app.toLowerCase()}`, name: s.app, fields: s.fields.map((f) => ({ id: fid(), key: canonical(f.name), value: "", secret: f.secret !== false, on: true, ...(f.help ? { help: f.help } : {}) })) };
}

/** What a failed suggestion says, by its reason; the sheet shows a blank item under it. @param {"no_account" | "no_answer" | undefined} why */
export const suggestionNote = (why) => (why === "no_account" ? "Connect your own AI account in Settings, AI accounts, and Vyre suggests the fields. For now, add them yourself." : "Vyre has no suggestion for that app. Add its fields yourself.");

/** A name for a need with several accounts: lowercase letters, digits and dashes. @param {string} typed */
const labelOf = (typed) => slugOf(typed).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * The save for a filled template. A module's need: vault.connect with the need's own field names (the module reads them), checked by the catalog on the server. A catalog app:
 * vault.put with its kind and the provider as a detail. A Space template or a blank item: an env-set (env-model.js itemCall). Values exactly as given; an optional field left
 * empty is left out.
 * @param {Template | null} t @param {Draft} d @param {{ member?: boolean }} [o]
 * @returns {{ tool: string, input: Record<string, unknown>, plain?: string[] } | { error: string }}
 */
export function saveCall(t, d, { member = false } = {}) {
  if (!t || t.source === "space") return itemCall(d, { member });
  const filled = d.fields.filter((f) => f.on && !(f.optional && !f.value));
  const bad = Object.values(fieldProblems(filled))[0];
  if (bad) return { error: bad };
  if (t.source === "need" && t.need) {
    if (member) return { error: "A module's key is added by the Space's owner." };
    /** @type {Record<string, string>} */ const fields = {};
    for (const f of filled) fields[f.key] = f.value;
    const label = t.need.multiple ? labelOf(d.name) : "";
    if (t.need.multiple && !label) return { error: "Give this account a name, like work or sales." };
    return { tool: "vault.connect", input: { module: t.need.module, need: t.need.id, fields, ...(label ? { label } : {}) } };
  }
  const p = t.provider ? PROVIDERS[t.provider] : null;
  if (!p) return itemCall(d, { member });
  const name = slugOf(d.name);
  if (!NAME_RE.test(name)) return { error: "Give the item a name." };
  const own = new Set(p.fields.map((f) => f.name));
  /** @type {Record<string, string>} */ const fields = {};
  for (const f of filled) {
    // the catalog's own fields keep the names the modules read; a field the person added is named in its one form
    const key = own.has(f.key) ? f.key : canonical(f.key);
    const pat = p.fields.find((x) => x.name === key)?.pattern;
    if (pat && !new RegExp(pat).test(f.value)) return { error: `The ${String(f.label || canonical(key)).toLowerCase()} does not look right for ${t.label}${f.value !== f.value.trim() ? ": it has a space or a new line at one end" : ""}. Check it and paste it again.` };
    fields[key] = f.value;
  }
  const plain = filled.filter((f) => !f.secret).map((f) => (own.has(f.key) ? f.key : canonical(f.key)));
  return member ? { tool: "vault.me.put", input: { name, kind: p.kinds[0], fields } } : { tool: "vault.put", input: { name, kind: p.kinds[0], fields, details: { provider: p.name } }, plain };
}

/** A login: its web address, username, password and an optional one-time code secret. @returns {Draft} */
export const loginDraft = () => ({ id: "login", name: "", fields: [
  { id: fid(), key: "url", label: "Web address", value: "", secret: false, on: true, optional: true },
  { id: fid(), key: "username", label: "Username", value: "", secret: false, on: true },
  { id: fid(), key: "password", label: "Password", value: "", secret: true, on: true },
  { id: fid(), key: "totp", label: "One-time code secret", value: "", secret: true, on: true, optional: true, help: "The setup key a site shows next to its QR code" }] });

/** A note: one multiline field. @returns {Draft} */
export const noteDraft = () => ({ id: "note", name: "", fields: [{ id: fid(), key: "text", label: "Note", value: "", secret: true, on: true }] });

/** The host of a web address, lower case, or "". @param {string} url */
const hostOf = (url) => { const m = /^(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?::\d+)?(?:[/?#]|$)/i.exec(String(url).trim()); return m ? m[1].toLowerCase() : ""; };

/**
 * The save for a login or a note. A login's address names the site it may be filled on (hosts); its username and password are kept exactly as typed.
 * @param {"login" | "note"} kind @param {Draft} d @param {{ member?: boolean }} [o] @returns {{ tool: string, input: Record<string, unknown> } | { error: string }}
 */
export function kindCall(kind, d, { member = false } = {}) {
  const name = slugOf(d.name);
  if (!NAME_RE.test(name)) return { error: "Give it a name." };
  const v = Object.fromEntries(d.fields.map((f) => [f.key, f.value]));
  const tool = member ? "vault.me.put" : "vault.put";
  if (kind === "note") return v.text ? { tool, input: { name, kind: "note", fields: { text: v.text } } } : { error: "Write the note." };
  if (!v.username || !v.password) return { error: "A login needs a username and a password." };
  const url = String(v.url ?? "").trim(), host = hostOf(url);
  if (url && !host) return { error: "That is not a web address." };
  const fields = { username: v.username, password: v.password, ...(v.totp ? { totp: v.totp } : {}), ...(member && url ? { url } : {}) };
  return { tool, input: { name, kind: "login", fields, ...(!member && host ? { url, hosts: [host] } : {}) } };
}

/**
 * What the Vault asks for at its top: a module's need that is not filled ("Comms needs a Twilio key: Auth token, Account number"), with the template a tap opens. Only what the
 * Add sheet offers; an AI account or a sign-in is asked for where it lives.
 * @param {Need[]} needs @returns {{ id: string, text: string, template: string }[]}
 */
export function needPrompts(needs) {
  return needs.filter((n) => n.state === "missing" && !n.optional && offered(n.provider)).map((n) => {
    const p = PROVIDERS[n.provider];
    const wants = fieldsOf(n).filter((f) => !f.optional).map((f) => short(f.label));
    return { id: `${n.module}:${n.id}`, text: `${moduleWord(n.module)} needs ${p.label.replace(/\s*\(.*$/, "")}: ${wants.join(", ")}.`, template: `need:${n.module}:${n.id}` };
  });
}
