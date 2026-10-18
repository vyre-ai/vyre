// @ts-check
// Connections on a record page: the rows of records.relationship.list (both directions, one list) as the sections a person reads: "Works at: Northwind since Mar 2023", and what ended kept apart and quiet.

/** "since Mar 2023", "since 2019, until Feb 2023", or nothing. @param {string | null | undefined} since @param {string | null | undefined} until */
export const whenWords = (since, until) => [since ? `since ${since}` : "", until ? `until ${until}` : ""].filter(Boolean).join(", ");

/**
 * The sections of the Connections card. A row whose kind reads from this record to the other keeps the kind as its title ("Parent of"); a row that reads the other way says so ("Parent of, from them"), so the
 * direction is never lost. Rows that ended come last, under "Before:". @param {any[]} rows @param {(urn: string) => string} titleOf
 */
export function groupConnections(rows, titleOf) {
  /** @type {Map<string, { title: string, items: any[] }>} */ const now = new Map();
  /** @type {Map<string, { title: string, items: any[] }>} */ const before = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const kind = String(r && r.kind || "Related");
    const base = r && r.direction === "to" ? `${kind}, from them` : kind;
    const ended = !!(r && r.until);
    const m = ended ? before : now;
    if (!m.has(base)) m.set(base, { title: ended ? `Before: ${base}` : base, items: [] });
    /** @type {any} */ (m.get(base)).items.push({ id: String(r.id), urn: String(r.other), title: titleOf(String(r.other)), note: String(r.note || ""), when: whenWords(r.since, r.until), ended });
  }
  return [...now.values(), ...before.values()];
}
