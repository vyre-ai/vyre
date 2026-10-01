// @ts-check
// resolve: the person's words for recipients ("Priya", "#launch") to ids the Gate can compare (P17).
//
// Deterministic and strict. An address, handle or channel the person typed is itself. A name
// resolves only when exactly one contact has that name or alias as a whole word; none or several
// and the intent gets to_ids null, which never matches anything, so the act is held for the
// person. No fuzzy matching, no guessing which Sam.
//
// No state, no I/O. The caller supplies the contacts.

import { EMAIL } from "../connectors/message.js";

/** @typedef {{ id: string, name: string, aliases?: string[], addresses?: string[] }} Contact */

const norm = s => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Is this recipient literal: an email address, @handle, #channel or phone number? */
export function literal(t) {
  const s = String(t ?? "").trim();
  return EMAIL.test(s) || /^@[\w.-]{1,64}$/.test(s) || /^#[\w-]{1,80}$/.test(s) || /^\+?\d[\d\s().-]{6,20}\d$/.test(s);
}

/** A literal recipient in the one form both sides compare: lowercase, phone digits only. */
export function canonical(t) {
  const s = String(t ?? "").trim();
  if (/^\+?\d[\d\s().-]{6,20}\d$/.test(s)) return (s.startsWith("+") ? "+" : "") + s.replace(/\D/g, "");
  return s.toLowerCase();
}

/** Contacts whose name or an alias contains word as a whole word or phrase. */
export function candidates(word, contacts) {
  const w = norm(word);
  if (!w) return [];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(w)}($|[^\\p{L}\\p{N}])`, "u");
  return (contacts || []).filter(c => [c.name, ...(c.aliases || [])].some(n => n && re.test(norm(n))));
}

/**
 * Give each intent to_ids (contact ids, or the literal address) and the words that did not
 * resolve. Any unresolved word makes the whole intent's to_ids null.
 * @template {{ to: string[], reply_to_current?: boolean }} T
 * @param {T[]} intents
 * @param {Contact[]} contacts
 * @param {{ replyTo?: string[] }} [opts] ids of whoever sent the message the person is looking at,
 *   for an intent with reply_to_current and no named recipient
 * @returns {(T & { to_ids: string[]|null, unresolved: string[] })[]}
 */
export function resolve(intents, contacts, { replyTo } = {}) {
  return (intents || []).map(intent => {
    const ids = [];
    const unresolved = [];
    for (const t of intent.to || []) {
      if (literal(t)) { ids.push(canonical(t)); continue; }
      const hits = candidates(t, contacts);
      if (hits.length === 1) ids.push(hits[0].id);
      else unresolved.push(t);
    }
    if (intent.reply_to_current && !(intent.to || []).length) {
      if (replyTo && replyTo.length) ids.push(...replyTo);
      else unresolved.push("(the current message)");
    }
    return { ...intent, to_ids: unresolved.length ? null : [...new Set(ids)], unresolved };
  });
}

/**
 * The id an outward call's recipient compares as: the one contact that owns the address, or the
 * address itself when no single contact does.
 * @param {string} address @param {Contact[]} contacts
 */
export function recipientId(address, contacts) {
  const a = canonical(address);
  const owners = (contacts || []).filter(c => (c.addresses || []).some(x => canonical(x) === a));
  return owners.length === 1 ? owners[0].id : a;
}
