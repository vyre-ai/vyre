// @ts-check
// Layouts: how a type is shown, for the whole Space (set by an owner or admin) and for one person (theirs alone, over the Space's). Stored as rows of the `record-layout` type. A layout is plain data the app
// draws: columns, sort, group, filters as structured conditions (never an expression string), the header fields per role, the related lists and the field groups. Pure checks first, then the tools.

const OPS = ["eq", "ne", "gt", "lt", "gte", "lte", "contains", "empty", "notempty", "in"];
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const names = (/** @type {any} */ a, /** @type {string} */ what, /** @type {number} */ max) => {
  if (!Array.isArray(a) || a.length > max || !a.every((x) => typeof x === "string" && NAME.test(x))) throw new Error(`${what} is a list of up to ${max} field names.`);
  return [...new Set(a)];
};

/** Check a layout and return it cleaned (only the keys it knows). Throws a plain sentence. @param {any} l */
export function cleanLayout(l) {
  if (!l || typeof l !== "object" || Array.isArray(l)) throw new Error("A layout is an object: columns, sort, group_by, filters, header_fields, related, field_groups.");
  const out = /** @type {Record<string, any>} */ ({});
  if (l.columns !== undefined) out.columns = names(l.columns, "columns", 40);
  if (l.sort !== undefined) {
    const s = l.sort;
    if (!s || !NAME.test(String(s.field)) || (s.dir !== undefined && !["asc", "desc"].includes(s.dir))) throw new Error("sort is { field, dir: asc or desc }.");
    out.sort = { field: s.field, dir: s.dir || "asc" };
  }
  if (l.group_by !== undefined && l.group_by !== null) { if (!NAME.test(String(l.group_by))) throw new Error("group_by is a field name."); out.group_by = l.group_by; }
  if (l.filters !== undefined) {
    if (!Array.isArray(l.filters) || l.filters.length > 20) throw new Error("filters is a list of up to 20 conditions { field, op, value }.");
    out.filters = l.filters.map((/** @type {any} */ f) => {
      if (!f || !NAME.test(String(f.field)) || !OPS.includes(f.op)) throw new Error(`A filter is { field, op, value } with op one of ${OPS.join(", ")}.`);
      const needsValue = !["empty", "notempty"].includes(f.op);
      if (needsValue && (f.value === undefined || (f.op === "in" && !Array.isArray(f.value)))) throw new Error(`The filter on ${f.field} needs a value${f.op === "in" ? " that is a list" : ""}.`);
      return needsValue ? { field: f.field, op: f.op, value: f.value } : { field: f.field, op: f.op };
    });
  }
  if (l.header_fields !== undefined) {
    if (!l.header_fields || typeof l.header_fields !== "object" || Array.isArray(l.header_fields)) throw new Error("header_fields maps a role name to up to 8 field names.");
    out.header_fields = Object.fromEntries(Object.entries(l.header_fields).slice(0, 30).map(([role, f]) => [String(role).slice(0, 60), names(f, `header_fields.${role}`, 8)]));
  }
  if (l.related !== undefined) {
    if (!Array.isArray(l.related) || l.related.length > 12) throw new Error("related is a list of up to 12 { type, via, label }.");
    out.related = l.related.map((/** @type {any} */ r) => {
      if (!r || typeof r.type !== "string" || typeof r.via !== "string" || !NAME.test(r.type) || !NAME.test(r.via)) throw new Error("A related list is { type, via, label }: the type that points here and the field it points with.");
      return { type: r.type, via: r.via, label: String(r.label || r.type).slice(0, 60) };
    });
  }
  if (l.field_groups !== undefined) {
    if (!Array.isArray(l.field_groups) || l.field_groups.length > 20) throw new Error("field_groups is a list of up to 20 { name, fields }.");
    const seen = new Set();
    out.field_groups = l.field_groups.map((/** @type {any} */ g) => {
      const name = String(g && g.name || "").trim();
      if (!name || name.length > 60 || seen.has(name.toLowerCase())) throw new Error("Every field group has its own name of up to 60 characters.");
      seen.add(name.toLowerCase());
      return { name, fields: names(g.fields, `field group ${name}`, 60) };
    });
  }
  return out;
}

/** The layout a person gets: theirs over the Space's, key by key. @param {any} space @param {any} mine */
export function effective(space, mine) {
  const out = { ...(space || {}), ...(mine || {}) };
  const source = {};
  for (const k of Object.keys(out)) /** @type {any} */ (source)[k] = mine && k in mine ? "mine" : "space";
  return { layout: out, source };
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function }} h */
export function registerLayouts({ tool, obj, str, refuse }) {
  const rows = async (/** @type {any} */ d, /** @type {string} */ type) => {
    try { return (await d.gateway.records.query(d.chain, "record-layout", { filter: { field: "type", op: "eq", value: type }, page: { limit: 200 } })).rows || []; } catch { return []; }
  };
  const me = (/** @type {any} */ d) => `person:${d.chain.hops[0].actor.id}`;
  const parse = (/** @type {any} */ r) => { try { return JSON.parse(r.data.layout || "{}"); } catch { return {}; } };
  tool("records.layout.get", "How a type is shown to you: { type } -> { layout, source } where layout is columns, sort, group_by, filters, header_fields, related and field_groups, your own choices laid over the Space's, and source says which key came from which.",
    obj({ space: str, type: str }, ["type"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const all = await rows(d, String(i.type));
      const sp = all.find((/** @type {any} */ r) => r.data.scope === "space");
      const mine = all.find((/** @type {any} */ r) => r.data.scope === "person" && r.data.owner === me(d));
      return effective(sp && parse(sp), mine && parse(mine));
    });
  tool("records.layout.set", "Save how a type is shown: { type, scope: space|mine, layout }. `space` is for everyone and an owner's or admin's act; `mine` is yours alone and lies over it. Saving replaces that scope's layout; { layout: {} } clears it.",
    obj({ space: str, type: str, scope: str, layout: { type: "object" } }, ["type", "scope", "layout"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      if (!["space", "mine"].includes(i.scope)) throw refuse("scope is space (everyone) or mine (you).", "bad_input");
      if (i.scope === "space") { let role = null; try { role = d.gateway.members.roleOf(d.chain.hops[0].actor); } catch { /* none */ } if (role !== "owner" && role !== "admin") throw refuse("Only an owner or an admin sets the layout for everyone. Save it as mine instead.", "not_allowed"); }
      let layout; try { layout = cleanLayout(i.layout); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      const scope = i.scope === "space" ? "space" : "person", owner = scope === "person" ? me(d) : "";
      const have = (await rows(d, String(i.type))).find((/** @type {any} */ r) => r.data.scope === scope && (r.data.owner || "") === owner);
      const data = { type: String(i.type), scope, owner, layout: JSON.stringify(layout) };
      if (have) await d.gateway.records.update(d.chain, "record-layout", have.id, data, have.version); else await d.gateway.records.create(d.chain, "record-layout", data);
      return { layout, scope: i.scope };
    });
}
