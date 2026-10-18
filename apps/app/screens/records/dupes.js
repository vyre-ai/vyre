// @ts-check
// "Looks like Ana Ruiz already exists": while a new record is typed, the records of the same type that share its email, its phone or its name. Read from the rows the person can already read, so it
// shows nothing they could not see. A hint, never a refusal: the person decides whether it is the same one.

const norm = (/** @type {any} */ v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const first = (/** @type {any} */ v) => (Array.isArray(v) ? v[0] : v);
const addrOf = (/** @type {any} */ v) => { const x = first(v); return norm(x && typeof x === "object" ? x.address ?? x.email ?? x.value ?? x.number : x); };
const NAMES = ["name", "full_name", "title"];
const MAILS = ["email", "emails"];
const PHONES = ["phone", "phones"];

/**
 * @param {any} def a type definition (its fields) @param {any[]} rows the records of that type @param {Record<string, any>} values what is typed so far @param {(rec: any) => string} titleOf
 * @returns {{ urn: string, title: string, why: string }[]} at most three, the strongest match first
 */
export function findDupes(def, rows, values, titleOf) {
  const have = (/** @type {string[]} */ names) => names.filter((n) => (def?.fields || []).some((/** @type {any} */ f) => f.name === n));
  const pick = (/** @type {string[]} */ names, /** @type {(v: any) => string} */ read) => { for (const n of have(names)) { const v = read(values[n]); if (v) return { n, v }; } return null; };
  const mail = pick(MAILS, addrOf), phone = pick(PHONES, addrOf), name = pick(NAMES, norm);
  /** @type {{ urn: string, title: string, why: string, rank: number }[]} */ const out = [];
  for (const r of rows || []) {
    const d = r.data || {};
    let why = "", rank = 9;
    if (mail && have(MAILS).some((n) => addrOf(d[n]) === mail.v)) { why = "the same email"; rank = 0; }
    else if (phone && have(PHONES).some((n) => addrOf(d[n]) === phone.v)) { why = "the same phone"; rank = 1; }
    else if (name && name.v.length > 2 && have(NAMES).some((n) => norm(d[n]) === name.v)) { why = "the same name"; rank = 2; }
    if (why) out.push({ urn: r.urn, title: titleOf(r), why, rank });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 3).map(({ urn, title, why }) => ({ urn, title, why }));
}
