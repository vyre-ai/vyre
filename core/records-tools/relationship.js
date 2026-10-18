// @ts-check
// Relationships: how one record relates to another (a person to a person, a person to a company, any type to any type), as rows of the `relationship` type, read from both ends.
// records.relationship.add / .list / .kinds / .kinds.set; registered by index.js. The list of kinds is the options of the type's `kind` choice, so a Space edits it like any other field.

/** Which side of a row the record is on, and who is on the other. @param {string} urn @param {any} row */
export function sideOf(urn, row) {
  const d = row.data || {};
  if (d.from_record === urn) return { direction: "from", other: d.to_record };
  return { direction: "to", other: d.from_record };
}

/** The rows as the list answers them: newest first, with the other end named. @param {string} urn @param {any[]} rows */
export function listed(urn, rows) {
  return rows.map((r) => ({ id: r.id, ...sideOf(urn, r), kind: r.data.kind, since: r.data.since || null, until: r.data.until || null, note: r.data.note || "" }))
    .sort((a, b) => String(b.since || "").localeCompare(String(a.since || "")) || a.id.localeCompare(b.id));
}

/** A kinds list, cleaned: trimmed, no empties, none twice in any case, at most 60 of up to 40 characters. Throws a plain sentence. @param {any} kinds */
export function cleanKinds(kinds) {
  if (!Array.isArray(kinds) || !kinds.length) throw new Error("Give at least one kind, for example Spouse.");
  const out = []; const seen = new Set();
  for (const k of kinds) {
    const w = String(k ?? "").trim();
    if (!w) continue;
    if (w.length > 40) throw new Error(`A kind is up to 40 characters: ${w.slice(0, 20)}...`);
    if (seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase()); out.push(w);
  }
  if (!out.length) throw new Error("Give at least one kind, for example Spouse.");
  if (out.length > 60) throw new Error("A Space has at most 60 relationship kinds.");
  return out;
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function }} h */
export function registerRelationships({ tool, obj, str, refuse, parseUrn }) {
  const rows = async (/** @type {any} */ d, /** @type {string} */ field, /** @type {string} */ urn) => {
    const r = await d.gateway.records.query(d.chain, "relationship", { filter: { field, op: "eq", value: urn }, page: { limit: 200 } });
    return r.rows || [];
  };
  const kindField = async (/** @type {any} */ d) => {
    const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === "relationship");
    if (!t) throw refuse("This Space has no relationship type yet. Ask an owner or admin to open Records once; it is made then.", "not_found");
    return { t, f: t.fields.find((/** @type {any} */ x) => x.name === "kind") };
  };
  tool("records.relationship.add", "Relate one record to another: { from, to, kind, since?, until?, note? }. `kind` reads from `from` to `to` (from is a Parent of to) and is one of records.relationship.kinds. Any record to any record in this Space.",
    obj({ space: str, from: str, to: str, kind: str, since: str, until: str, note: str }, ["from", "to", "kind"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const a = parseUrn(i.from), b = parseUrn(i.to);
      if (a.space !== b.space) throw refuse("A relationship joins two records of the same Space.", "bad_input");
      if (i.from === i.to) throw refuse("A record cannot be related to itself. Pick another record for `to`.", "bad_input");
      for (const [u, x] of [[i.from, a], [i.to, b]]) if (!(await d.gateway.records.get(d.chain, x.type, x.id))) throw refuse(`${u} is not here, or you may not read it. Pick a record you can see in Records.`, "not_found");
      const { f } = await kindField(d);
      if (f && Array.isArray(f.options) && !f.options.includes(i.kind)) throw refuse(`${i.kind} is not one of this Space's relationship kinds: ${f.options.join(", ")}. records.relationship.kinds.set changes the list.`, "bad_input");
      const data = { from_record: i.from, to_record: i.to, kind: i.kind, ...(i.since ? { since: i.since } : {}), ...(i.until ? { until: i.until } : {}), ...(i.note ? { note: i.note } : {}) };
      return { relationship: await d.gateway.records.create(d.chain, "relationship", data) };
    });
  tool("records.relationship.remove", "Take a relationship away: { id } is a row from records.relationship.list. The kernel decides who may; the two records are not touched.",
    obj({ space: str, id: str }, ["id"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const row = await d.gateway.records.get(d.chain, "relationship", String(i.id));
      if (!row) throw refuse("That relationship is not here, or you may not see it.", "not_found");
      await d.gateway.records.remove(d.chain, "relationship", row.id, row.version);
      return { removed: row.id };
    });
  tool("records.relationship.list", "Everything a record is related to, both directions in one list: [{ id, direction: from|to, other, kind, since, until, note }]. `from` means this record is the first end (it is a Parent of other).",
    obj({ space: str, urn: str }, ["urn"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      parseUrn(i.urn);
      const all = [...(await rows(d, "from_record", i.urn)), ...(await rows(d, "to_record", i.urn))];
      return { relationships: listed(i.urn, all) };
    }, (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space }));
  tool("records.relationship.kinds", "The kinds of relationship this Space offers, in order.", obj({ space: str }), async (_i, /** @type {any} */ d) => ({ kinds: ((await kindField(d)).f || {}).options || [] }));
  tool("records.relationship.kinds.set", "Replace the list of relationship kinds: { kinds: [name] }. Rows that use a kind you remove keep it as written.",
    obj({ space: str, kinds: { type: "array", items: { type: "string" } } }, ["kinds"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      let kinds; try { kinds = cleanKinds(i.kinds); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      const { t } = await kindField(d);
      await d.gateway.records.define(d.chain, { change_types: [{ ...t, fields: t.fields.map((/** @type {any} */ x) => (x.name === "kind" ? { ...x, options: kinds } : x)) }] });
      return { kinds };
    });
}
