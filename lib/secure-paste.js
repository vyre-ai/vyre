// @ts-check
// A key pasted into a message never reaches a model (R031-68). Two halves of ONE rule, both built on credential-shapes' locateSecrets: the person's own app saves the key to the Vault first (secureSecrets, with the
// Vault's yes) and sends vault://name in its place; the server's chat entries (threads.send, threads.start, threads.edit-retry, stream.send) refuse any text that still holds a key (keyInText), whoever sends it,
// so a surface that has no such client, or a model, cannot carry one in. The server does not save on its own: the Vault's floor needs the person's yes on that exact save, which only the person's surface can give.
// A key pasted into a message goes to the Vault before the message goes anywhere. The text that is sent holds a reference (vault://name) where the key was, so neither the assistant nor the
// transcript ever holds the value (R031-68). What counts as a key is lib/credential-shapes.js's call (locateSecrets); this file only moves the value and swaps the text. Pure: the app hands in
// `list` (the Vault's item names) and `put` (vault.put, which asks the person's presence on that exact save), and Node tests it.
import { locateSecrets } from "./credential-shapes.js";

/** @typedef {{ name: string, label: string }} Secured */

/** A reference the chat draws as a small "secured in the Vault" tag. */
export const REF_IN_TEXT = /vault:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/g;

const slug = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The item name for a found key: "anthropic-key", then "anthropic-key-2" when that is taken. The Vault's put replaces an item of the same name, so a new key never reuses one. */
export function nameFor(/** @type {{ label: string }} */ f, /** @type {Set<string>} */ taken) {
  const base = slug(f.label) || "pasted-secret";
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
  return name;
}

/** The vault.put input for one found key. Its value is in `fields` and nowhere else. */
export function putFor(/** @type {{ type: string, value: string }} */ f, /** @type {string} */ name) {
  const kind = f.type === "private-key" ? "secret" : f.type === "db-url" ? "db-url" : "api-key";
  return { name, kind, description: "Pasted in chat", fields: kind === "db-url" ? { url: f.value } : { value: f.value } };
}

/** The words for a save that did not happen. Our own sentences; the box's text is never shown. @param {string | undefined} code */
export function refusal(code) {
  if (code === "presence_required") return "Your key was not secured, so nothing was sent. Approve on this device, then send it again.";
  if (code === "locked" || code === "vault_locked") return "The Vault is locked, so nothing was sent. Unlock it, then send the message again.";
  if (code === "denied" || code === "forbidden") return "This device may not add to the Vault, so nothing was sent. Take the key out of the message and send it again.";
  return "The Vault did not take your key, so nothing was sent. Take the key out of the message, or try again.";
}

/**
 * @param {string} text what the person typed
 * @param {{ list: () => Promise<string[]>, put: (input: Record<string, unknown>) => Promise<unknown>, onSecuring?: (label: string) => void }} io
 * @returns {Promise<{ text: string, secured: Secured[] } | { error: string, secured: Secured[] }>}
 */
export async function secureSecrets(text, io) {
  const found = locateSecrets(text);
  if (!found.length) return { text, secured: [] };
  /** @type {Set<string>} */ let taken = new Set();
  try { taken = new Set((await io.list()).map(n => String(n).toLowerCase())); } catch { /* the put below says if the Vault is not there */ }
  /** @type {Map<string, string>} one item per distinct value, so a key pasted twice is saved once */
  const byValue = new Map();
  /** @type {Secured[]} */ const secured = [];
  for (const f of found) {
    if (byValue.has(f.value)) continue;
    const name = nameFor(f, taken);
    io.onSecuring?.(f.label);
    try { await io.put(putFor(f, name)); } catch (e) { return { error: refusal(/** @type {any} */ (e)?.code), secured }; }
    taken.add(name.toLowerCase());
    byValue.set(f.value, name);
    secured.push({ name, label: f.label });
  }
  let out = text;
  for (const f of [...found].reverse()) out = out.slice(0, f.start) + `vault://${byValue.get(f.value)}` + out.slice(f.end);
  return { text: out, secured };
}

/** A message split into plain text and the Vault references in it, for drawing a tag where each reference sits. @param {string} text @returns {({ text: string } | { vault: string })[]} */
export function partsOf(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(REF_IN_TEXT)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ vault: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * For a server entry that takes words for a model: null when the text holds no key, else the refusal to throw. Names the kinds found, never a match.
 * @param {unknown} text
 * @returns {null | { code: "secret_in_message", message: string, detail: { found: { label: string }[] } }}
 */
export function keyInText(text) {
  if (typeof text !== "string" || !text) return null;
  const found = locateSecrets(text);
  if (!found.length) return null;
  const labels = [...new Set(found.map(f => f.label))];
  return {
    code: "secret_in_message",
    message: `That message holds ${labels.length === 1 ? `a ${labels[0].toLowerCase()}` : "keys"}, so it was not sent and no assistant has seen it. Save it in the Vault (vyre vault put, or paste it in the Vyre app, which saves it for you) and send vault://name instead.`,
    detail: { found: labels.map(label => ({ label })) },
  };
}

/** Throw keyInText's refusal, if any. @param {unknown} text */
export function refuseKey(text) {
  const r = keyInText(text);
  if (r) throw Object.assign(new Error(r.message), { code: r.code, detail: r.detail });
}
