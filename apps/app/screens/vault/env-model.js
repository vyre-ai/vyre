// @ts-check
// The Vault as an .env you can share safely, as rules without a screen: an item is a NAME and a list of FIELDS named like environment variables, each secret or plain. Pasting
// KEY=value lines makes items grouped by their common prefix; field names have one form (UPPER_SNAKE, lib/env-name.js); values are kept byte-exact and only warned about; search
// finds an item by its name or any field's name. Pure, so Node tests it. Values pass through here only on their way to the person's own Save, Copy or Reveal.
import { canonical, clashes } from "../../../../lib/env-name.js";
import { envEntries, envLine } from "../../../../lib/env-lines.js";
import { classify } from "../../../../lib/credential-shapes.js";

export { canonical, clashes };

/** The rule for an item's stored name: letters, digits, dot, dash and underscore. */
export const NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** An item's name as the vault keeps it: spaces become dashes, anything else not allowed is dropped. @param {string} typed */
export const slugOf = (typed) => String(typed).trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 128);

/** An item's stored name as people read it. @param {string} stored */
export const shownName = (stored) => String(stored).replace(/[-_]+/g, " ").trim();

/** The words the person typed, when the stored slug is not those words. Empty when they match, or when a title cannot hold them. @param {string} typed @param {string} slug */
export function titleOf(typed, slug) {
  const t = String(typed).trim();
  return t && t !== slug && t.length <= 80 ? t : "";
}

/** What the list shows: the title they typed, else the slug with dashes and underscores as spaces. @param {string} stored @param {{ title?: unknown } | null | undefined} [details] */
export function readTitle(stored, details) {
  const t = details && typeof details.title === "string" ? details.title.trim() : "";
  return t || shownName(stored);
}

/**
 * @typedef {{ id: string, key: string, value: string, secret: boolean, on: boolean, help?: string, label?: string, optional?: boolean }} DField
 *   one field being added: `key` is what the person typed (shown live in its one form), `value` exactly as given
 * @typedef {{ id: string, name: string, fields: DField[] }} Draft one item being added
 */

/** Is this value a secret, by the vault's one secret detector (lib/credential-shapes.js)? A field is plain only when the detector says so. @param {string} key @param {string} value */
export const guessSecret = (key, value) => Boolean(classify(canonical(key), value).secret);

/** The name a group of pasted fields starts with: an acronym stays capitals (GHL), a word is capitalised once (Twilio). @param {string} prefix */
const groupName = (prefix) => (prefix === "OTHER" ? "Other settings" : prefix.length <= 4 ? prefix : prefix[0] + prefix.slice(1).toLowerCase());

/**
 * Pasted .env lines as items: every KEY=value read exactly (lib/env-lines.js, the import's own parser in its exact reading), grouped by the first word of the name (GHL_API_KEY and
 * GHL_LOCATION_ID are one item, GHL), each field secret or plain by the vault's own detector. What could not be read is listed by line, never by value.
 * @param {string} text @returns {{ drafts: Draft[], skipped: string[] }}
 */
export function pasteDrafts(text) {
  const { entries, skipped } = envEntries(text, { exact: true });
  /** @type {Map<string, Draft>} */
  const by = new Map();
  for (const e of entries) {
    const c = canonical(e.key);
    const prefix = c.includes("_") ? c.split("_").filter(Boolean)[0] : "OTHER";
    const d = by.get(prefix) ?? { id: `g${by.size}`, name: groupName(prefix), fields: [] };
    d.fields.push({ id: `f${entries.indexOf(e)}`, key: c, value: e.value, secret: guessSecret(c, e.value), on: true });
    by.set(prefix, d);
  }
  return { drafts: [...by.values()], skipped };
}

/** Move one field to another item of the preview, or to a new item of its own ("new"). Empty items go. @param {Draft[]} drafts @param {string} fieldId @param {string} to */
export function moveField(drafts, fieldId, to) {
  const f = drafts.flatMap((d) => d.fields).find((x) => x.id === fieldId);
  if (!f) return drafts;
  let out = drafts.map((d) => ({ ...d, fields: d.fields.filter((x) => x.id !== fieldId) }));
  if (to === "new") out = [...out, { id: `n${fieldId}`, name: groupName(canonical(f.key).split("_")[0] || "OTHER"), fields: [f] }];
  else out = out.map((d) => (d.id === to ? { ...d, fields: [...d.fields, f] } : d));
  return out.filter((d) => d.fields.length);
}

/** Change one field of one draft. @param {Draft[]} drafts @param {string} fieldId @param {Partial<DField>} change */
export const setField = (drafts, fieldId, change) => drafts.map((d) => ({ ...d, fields: d.fields.map((f) => (f.id === fieldId ? { ...f, ...change } : f)) }));

/**
 * The quiet note under a value that starts or ends with a space or a new line, a common paste mistake. The value is never changed for the person: they tap "Remove it".
 * @param {string} v @returns {string | null}
 */
export function valueWarning(v) {
  const s = String(v ?? "");
  if (!s || !s.trim()) return null;
  const head = /^\s/.test(s), nl = /[\r\n]$/.test(s), tail = /\s$/.test(s);
  if (head && tail) return "This value starts and ends with a space.";
  if (head) return "This value starts with a space.";
  if (nl) return "This value ends with a new line.";
  if (tail) return "This value ends with a space.";
  return null;
}

/** What "Remove it" makes of a value: the spaces and new lines at its two ends go, nothing inside it changes. @param {string} v */
export const withoutEnds = (v) => String(v).replace(/^\s+|\s+$/g, "");

/**
 * What is wrong with an item's fields, by field id, in words: a name with nothing usable, or a name the item already has in its one form ("This item already has API_KEY").
 * @param {{ id: string, key: string, on?: boolean, value?: string, optional?: boolean }[]} fields @param {{ needValue?: boolean }} [o]
 * @returns {Record<string, string>}
 */
export function fieldProblems(fields, { needValue = true } = {}) {
  /** @type {Record<string, string>} */ const out = {};
  /** @type {Set<string>} */ const seen = new Set();
  for (const f of fields) {
    if (f.on === false) continue;
    const c = canonical(f.key);
    if (!c) { out[f.id] = "Give the field a name, like API_KEY."; continue; }
    if (seen.has(c)) { out[f.id] = `This item already has ${c}.`; continue; }
    seen.add(c);
    if (needValue && !f.optional && !String(f.value ?? "").trim()) out[f.id] = `${c} needs a value.`;
  }
  return out;
}

/**
 * The save for one item of fields: vault.put as an env-set (the owner's vault: Mine, or Shared then moved to its folder by the caller), or vault.me.put in a member's own vault.
 * Names in their one form, values exactly as given. `plain` names the plain fields, which the caller saves as the item's rule (vault.use.set, core/vault/use.js: the one store of
 * which fields are plain). A reason instead when it cannot be saved yet.
 * @param {{ name: string, fields: DField[] }} d @param {{ member?: boolean }} [o]
 * @returns {{ tool: string, input: Record<string, unknown>, plain: string[] } | { error: string }}
 */
export function itemCall(d, { member = false } = {}) {
  const name = slugOf(d.name);
  if (!name || !NAME_RE.test(name)) return { error: "Give the item a name." };
  const on = d.fields.filter((f) => f.on);
  if (!on.length) return { error: "Tick at least one field." };
  const bad = Object.values(fieldProblems(on))[0];
  if (bad) return { error: bad };
  /** @type {Record<string, string>} */ const fields = {};
  for (const f of on) fields[canonical(f.key)] = f.value;
  const plain = on.filter((f) => !f.secret).map((f) => canonical(f.key));
  // A member's own vault has no details field. The owner's item keeps the typed words as its title.
  const title = member ? "" : titleOf(d.name, name);
  const input = { name, kind: "env-set", fields, ...(title ? { details: { title } } : {}) };
  return member ? { tool: "vault.me.put", input, plain: [] } : { tool: "vault.put", input, plain };
}

/**
 * @typedef {{ id: string, name: string, kind?: string, fields: { name: string, plain: boolean }[], provider?: string }} Listed an item as the list shows it: field names, never a value
 */

/** Words the search compares: lower case, letters and digits only. @param {string} s */
const flat = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Items whose name, or any field's name, holds every word typed: "LOCATION_ID" or "location id" finds the item with GHL_LOCATION_ID. Field names compare in their one form.
 * @template {Listed} T @param {T[]} items @param {string} q @returns {T[]}
 */
export function searchItems(items, q) {
  const words = String(q).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const whole = flat(q);
  return items.filter((v) => {
    const hay = [flat(v.name), flat(v.id), ...v.fields.map((f) => flat(canonical(f.name)))];
    return hay.some((h) => h.includes(whole)) || words.every((w) => hay.some((h) => h.includes(flat(w))));
  });
}

/** One item's fields as .env lines, names in their one form, values byte-exact (lib/env-lines.js reads them back the same). @param {{ name: string, value: string }[]} fields */
export const toDotenv = (fields) => fields.map((f) => envLine(canonical(f.name), f.value)).join("\n") + "\n";

/** What a person can check a secret by without copying it: its length, and its last four characters when it is long enough that four say little. @param {string} v */
export function secretHint(v) {
  const n = String(v).length;
  const len = `${n} ${n === 1 ? "character" : "characters"}`;
  return n >= 12 ? `${len}, ends in ${String(v).slice(-4)}` : len;
}

/** How an agent or a Flow names one field of an item: the placeholder the server fills in (work/0.6.4 vault placeholders). @param {string} item @param {string} field */
export const placeholder = (item, field) => `{{vault:${item}.${canonical(field)}}}`;

/**
 * A field's name as the person types it, shown in its one form at once ("ghl api" reads GHL_API while typing); a separator just typed is kept so the next word can follow. Saving
 * makes it canonical (lib/env-name.js), which only drops a separator left at the end.
 * @param {string} typed
 */
export const liveName = (typed) => String(typed).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+/, "").slice(0, 64);

/** The words a field is shown by: its one form, except a login's and a note's own fields, which keep plain words. @param {string | undefined} kind @param {string} name */
export function fieldLabel(kind, name) {
  if (kind === "login") return ({ username: "Username", password: "Password", totp: "One-time code", url: "Web address" })[/** @type {"username"} */ (name)] ?? canonical(name);
  if (kind === "note" && name === "text") return "Note";
  return canonical(name);
}
