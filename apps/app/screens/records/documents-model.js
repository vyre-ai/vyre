// @ts-check
// The pure half of the record page's Documents bar (documents.generate, documents.send, documents.signing.waiting).

/** The records a template can draw on: this one by its type's name and as `record`, and the first record of each related type by that type's name. A related record never takes the name of the record itself. @param {{ name: string }} def @param {{ urn: string }} rec @param {{ urn: string, type: string }[]} related @returns {Record<string, string>} */
export function aliasesFor(def, rec, related) {
  /** @type {Record<string, string>} */ const out = { [def.name]: rec.urn, record: rec.urn };
  for (const r of related) if (!(r.type in out)) out[r.type] = r.urn;
  return out;
}

/** The waiting signature requests that are for this address. @param {any[] | null | undefined} requests @param {string} email */
export const waitingFor = (requests, email) => (email && Array.isArray(requests) ? requests.filter((r) => String(r?.email ?? "").toLowerCase() === email.toLowerCase()) : []);

/** The placeholders no record here provides: those without a record name before the dot, and those whose name is not one of the aliases (brand is always there). @param {string[]} placeholders @param {string[]} aliases */
export const unfilled = (placeholders, aliases) => placeholders.filter((p) => { const head = p.includes(".") ? p.split(".")[0] : ""; return !(head && (head === "brand" || aliases.includes(head))); });

/** "3 hours ago". @param {number | undefined} at @param {number} now */
export function whenWords(at, now) {
  if (typeof at !== "number") return "";
  const m = Math.round((now - at) / 60_000);
  if (m < 2) return "just now";
  if (m < 120) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}
