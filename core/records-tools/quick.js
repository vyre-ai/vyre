// @ts-check
// Fast fields: a person adds a field to a type and it works at once. The value lives in the record's `extra` bag (JSON text) while the field is "bag"; records.field.promote makes the real field in the store (slow:
// the store takes seconds per field), copies the values over row by row, and marks the field "real". Reads show bag values as ordinary data; writes of a bag field go to the bag. Filters and sorts need the real field.
// The fields are rows of the `quick-field` type { type, name, label, kind, options, state }. All of it runs under the caller's own chain; adding a field is an owner's or admin's act, as defining a type is.

export const QUICK_KINDS = ["text", "rich_text", "number", "boolean", "date", "datetime", "choice"];
/** A link is not a fast field (it needs the store's own field and an inverse): records.field.add hands it to records.link.add. */
export const LINK_KIND = "link";
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(["id", "ref", "extra", "stage", "name", "version", "created_at", "updated_at"]);

/** A field name from its label: "Next review" is next_review. @param {string} label */
export const nameOfLabel = (label) => String(label || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]+/, "").slice(0, 40);

/** The bag of a record, as an object (bad or missing JSON is an empty bag). @param {any} v */
export function bagOf(v) {
  if (v && typeof v === "object") return { ...v };
  try { const o = JSON.parse(String(v || "")); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/** A value is fit for its kind. Returns the problem, or "". @param {{ kind: string, options?: string[] }} f @param {any} v */
export function problemWith(f, v) {
  if (v === null || v === undefined || v === "") return "";
  if (f.kind === "number") return typeof v === "number" && Number.isFinite(v) ? "" : "needs a number";
  if (f.kind === "boolean") return typeof v === "boolean" ? "" : "needs true or false";
  if (f.kind === "choice") return (f.options || []).includes(v) ? "" : `needs one of: ${(f.options || []).join(", ")}`;
  if (f.kind === "date") return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? "" : "needs a date like 2026-11-30";
  if (f.kind === "datetime") return Number.isFinite(Date.parse(String(v))) ? "" : "needs a date and time";
  return typeof v === "string" ? "" : "needs text";
}

/** Show bag values as ordinary data. A real value wins over a bag value of the same name. @param {any} rec @param {any[]} fields */
export function mergeOut(rec, fields) {
  if (!rec || !rec.data || !fields.length) return rec;
  const bag = bagOf(rec.data.extra);
  const data = { ...rec.data };
  for (const f of fields) if ((data[f.name] === undefined || data[f.name] === null) && bag[f.name] !== undefined) data[f.name] = bag[f.name];
  return { ...rec, data };
}

/** Move bag-field values of a write into the bag. `current` is the bag the record already holds. Fields in the "real" or "promoting" state go to the store as they are. @param {Record<string, any>} data @param {any[]} fields @param {any} [current] */
export function splitIn(data, fields, current) {
  const out = { ...data };
  const bag = bagOf(current);
  let touched = false;
  for (const f of fields.filter((x) => x.state === "bag")) {
    if (!(f.name in out)) continue;
    const bad = problemWith(f, out[f.name]);
    if (bad) throw Object.assign(new Error(`${f.label || f.name} ${bad}.`), { code: "bad_input" });
    if (out[f.name] === null || out[f.name] === "" || out[f.name] === undefined) delete bag[f.name]; else bag[f.name] = out[f.name];
    delete out[f.name]; touched = true;
  }
  if (touched) out.extra = JSON.stringify(bag);
  return out;
}

/** The refusal for a filter or sort on a bag field. @param {any} spec @param {any[]} fields */
export function bagInQuery(spec, fields) {
  const names = new Set(fields.filter((f) => f.state === "bag").map((f) => f.name));
  if (!names.size) return null;
  const hit = [];
  const walk = (/** @type {any} */ f) => { if (!f || typeof f !== "object") return; if (typeof f.field === "string" && names.has(f.field.split(".")[0])) hit.push(f.field); for (const v of Object.values(f)) if (v && typeof v === "object") walk(v); };
  walk(spec && spec.filter); for (const s of (spec && spec.sort) || []) walk(s);
  return hit.length ? hit[0] : null;
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function, addLink: (i: any, d: any) => Promise<any> }} h */
export function registerQuick({ tool, obj, str, refuse, addLink }) {
  const fieldsOf = async (/** @type {any} */ d, /** @type {string} */ type) => quickFieldsOf(d, type);
  const admin = (/** @type {any} */ d) => { let role = null; try { role = d.gateway.members.roleOf(d.chain.hops[0].actor); } catch { /* none */ } if (role !== "owner" && role !== "admin") throw refuse("Only an owner or an admin adds a field. Ask one of them.", "not_allowed"); };
  tool("records.field.add", "Add a field to a record type so it works at once: { type, label, kind (text|rich_text|number|boolean|date|datetime|choice|link), options? }. kind link also takes { to: the type it links to, inverse?: what the other type calls it, many? } and is a real field at once (the same as records.link.add); a relationship kind belongs to the connection, so pass kind to records.link.set. The value is kept with the record until records.field.promote makes it a real field (the app does that in the background). An owner's or admin's act.",
    obj({ space: str, type: str, label: str, kind: str, options: { type: "array", items: { type: "string" } }, to: str, inverse: str, many: { type: "boolean" } }, ["type", "label", "kind"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      admin(d);
      if (i.kind === LINK_KIND) return addLink(i, d);
      const type = String(i.type), kind = String(i.kind);
      if (!QUICK_KINDS.includes(kind)) throw refuse(`A fast field is one of: ${QUICK_KINDS.join(", ")}. Other kinds are added from Settings, Objects.`, "bad_input");
      const name = nameOfLabel(i.label);
      if (!NAME.test(name) || RESERVED.has(name)) throw refuse(`"${i.label}" cannot be a field name. Pick another label.`, "bad_input");
      const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === type);
      if (!t) throw refuse(`There is no record type called ${type}. Pick one of the types shown in Records.`, "not_found");
      if ((t.fields || []).some((/** @type {any} */ f) => f.name === name)) throw refuse(`${t.label || type} already has a field called ${name}. Pick another label.`, "duplicate");
      if ((await fieldsOf(d, type)).some((f) => f.name === name)) throw refuse(`${t.label || type} already has a fast field called ${name}. Pick another label.`, "duplicate");
      const options = kind === "choice" ? (Array.isArray(i.options) ? i.options.map(String).filter(Boolean) : []) : [];
      if (kind === "choice" && !options.length) throw refuse("A choice field needs its options: { options: [..] }.", "bad_input");
      let hasBag = (t.fields || []).some((/** @type {any} */ f) => f.name === "extra");
      // a type made before the bag existed gets it once, now (one definition change)
      if (!hasBag) await d.gateway.records.define(d.chain, { change_types: [{ ...t, fields: [...t.fields, { name: "extra", kind: "text", label: "Extra fields" }] }] });
      const row = await d.gateway.records.create(d.chain, "quick-field", { type, name, label: String(i.label).trim(), kind, options: JSON.stringify(options), state: "bag" });
      return { field: { name, label: String(i.label).trim(), kind, options, state: "bag", id: row.id } };
    });
  tool("records.field.status", "The fast fields of a type and where each is: bag (kept with the record), promoting or real (a field of the store). { type } -> [{ name, label, kind, state }].",
    obj({ space: str, type: str }, ["type"]), async (/** @type {any} */ i, /** @type {any} */ d) => ({ fields: (await fieldsOf(d, String(i.type))).map((f) => ({ name: f.name, label: f.label, kind: f.kind, options: f.options, state: f.state })) }));
  tool("records.field.promote", "Make a fast field a real field of the store and move its values over: { type, name }. Safe to call again: it carries on where it stopped. Answers { state, done, total, failed }. An owner's or admin's act.",
    obj({ space: str, type: str, name: str }, ["type", "name"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      admin(d);
      const type = String(i.type), name = String(i.name);
      const q = (await quickRows(d, type)).find((r) => r.data.name === name);
      if (!q) throw refuse(`${type} has no fast field called ${name}. Pick one of the fields shown on its page.`, "not_found");
      const f = { name, label: q.data.label, kind: q.data.kind, options: JSON.parse(q.data.options || "[]") };
      if (q.data.state === "bag") {
        const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === type);
        if (!t) throw refuse(`There is no record type called ${type}. Pick one of the types shown in Records.`, "not_found");
        if (!(t.fields || []).some((/** @type {any} */ x) => x.name === name)) {
          const real = { name, kind: f.kind, label: f.label, ...(f.kind === "choice" ? { options: f.options } : {}) };
          await d.gateway.records.define(d.chain, { change_types: [{ ...t, fields: [...t.fields, real] }] });
        }
        q.version = (await d.gateway.records.update(d.chain, "quick-field", q.id, { state: "promoting" }, q.version)).version;
      }
      let done = 0, failed = 0, total = 0, cursor = undefined;
      for (;;) {
        const page = await d.gateway.records.query(d.chain, type, { page: { limit: 100, ...(cursor ? { cursor } : {}) } });
        for (const r of page.rows || []) {
          const bag = bagOf(r.data.extra);
          if (bag[name] === undefined) continue;
          total++;
          const rest = { ...bag }; delete rest[name];
          try { await d.gateway.records.update(d.chain, type, r.id, { [name]: bag[name], extra: JSON.stringify(rest) }, r.version); done++; } catch { failed++; }
        }
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      const state = failed ? "promoting" : "real";
      if (!failed) await d.gateway.records.update(d.chain, "quick-field", q.id, { state: "real" }, q.version);
      return { state, done, total, failed };
    });
}

/** The quick-field rows of a type. @param {any} d @param {string} type */
export async function quickRows(d, type) {
  // no filter on the data field `type`: it came back empty for a member (see layout.js); the rows are few
  try { return ((await d.gateway.records.query(d.chain, "quick-field", { page: { limit: 200 } })).rows || []).filter((/** @type {any} */ r) => r.data && r.data.type === type); } catch { return []; }
}
/** One quick-field row in the shape the helpers use. @param {any} r */
const shapeOf = (r) => { let options = []; try { options = JSON.parse(r.data.options || "[]"); } catch { /* none */ } return { name: r.data.name, label: r.data.label, kind: r.data.kind, options, state: r.data.state }; };
/**
 * The fields records.types lists for a type: its own, then each fast field that is not a real field yet, marked `fast: true` with its state, so a column added a moment ago shows at once. A fast field that is
 * real is in the type's own fields already. @param {any} t @param {any[]} quick the type's quick fields
 */
export function withFastFields(t, quick) {
  const own = new Set((t.fields || []).map((/** @type {any} */ f) => f.name));
  const fast = quick.filter((f) => f.state !== "real" && !own.has(f.name)).map((f) => ({ name: f.name, label: f.label, kind: f.kind, ...(f.kind === "choice" ? { options: f.options } : {}), fast: true, state: f.state }));
  return fast.length ? { ...t, fields: [...(t.fields || []), ...fast] } : t;
}
/** A definition change without the fast fields records.types added: they are rows of quick-field, never fields of the store, until records.field.promote makes them so. @param {any} diff */
export function withoutFastFields(diff) {
  if (!diff || typeof diff !== "object") return diff;
  const strip = (/** @type {any} */ list) => (Array.isArray(list) ? list.map((t) => (t && Array.isArray(t.fields) && t.fields.some((/** @type {any} */ f) => f && f.fast === true) ? { ...t, fields: t.fields.filter((/** @type {any} */ f) => !(f && f.fast === true)) } : t)) : list);
  return { ...diff, ...(diff.add_types ? { add_types: strip(diff.add_types) } : {}), ...(diff.change_types ? { change_types: strip(diff.change_types) } : {}) };
}
/** Every type's quick fields from one read of the rows. @param {any} d @returns {Promise<Map<string, any[]>>} */
export async function quickFieldsByType(d) {
  /** @type {Map<string, any[]>} */ const out = new Map();
  let rows = [];
  try { rows = (await d.gateway.records.query(d.chain, "quick-field", { page: { limit: 200 } })).rows || []; } catch { return out; }
  for (const r of rows) if (r && r.data && typeof r.data.type === "string") { const list = out.get(r.data.type) || []; list.push(shapeOf(r)); out.set(r.data.type, list); }
  return out;
}
/** The quick fields of a type in the shape the helpers use. @param {any} d @param {string} type */
export async function quickFieldsOf(d, type) {
  return (await quickRows(d, type)).map(shapeOf);
}
