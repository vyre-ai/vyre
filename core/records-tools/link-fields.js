// @ts-check
// Link fields with an inverse, for people who do not write definitions. A link to another type shows on both records: "Company" on a Contact, "Contacts" on the Company, kept by the kernel (kernel/gateway/links.js).
//   records.link.add { type, label, to, many?, inverse_label? }   add the link field to a type; the target type gets the inverse
//   records.link.set { urn, field, to, kind? }                   connect a record through a link field; with `kind` the connection is also kept as a relationship of that kind (a Referrer, an Employer)
import { nameOfLabel } from "./quick.js";

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(["id", "ref", "extra", "stage", "name", "version", "created_at", "updated_at"]);

/** The link field to add, and its inverse when one was named. Throws a plain sentence. @param {{ label?: any, to?: any, many?: any, inverse_label?: any, required?: any }} i @param {any} type the type it goes on @param {any[]} defs every type of the Space */
export function linkFieldFrom(i, type, defs) {
  const label = String(i.label || "").trim();
  const name = nameOfLabel(label);
  if (!label || label.length > 60 || !NAME.test(name) || RESERVED.has(name)) throw new Error(`"${label}" cannot be a field name. Pick another label.`);
  if ((type.fields || []).some((/** @type {any} */ f) => f.name === name)) throw new Error(`${type.label || type.name} already has a field called ${name}. Pick another label.`);
  const to = String(i.to || "");
  if (!defs.some((t) => t.name === to)) throw new Error(`There is no record type called ${to || "(none)"} to link to. Pick one of the types shown in Records.`);
  const field = /** @type {any} */ ({ name, kind: "link", label, to, ...(i.many === true ? { many: true } : {}), ...(i.required === true ? { required: true } : {}) });
  if (i.inverse_label !== undefined) {
    const il = String(i.inverse_label).trim();
    const iname = nameOfLabel(il);
    if (!il || il.length > 60 || !NAME.test(iname)) throw new Error(`"${il}" cannot name the other end. Pick another label.`);
    field.inverse = { name: iname, label: il };
  }
  return field;
}

/** The value a link field takes for the record(s) named. @param {any} field @param {string | string[] | null} to */
export function linkValue(field, to) {
  if (to === null || to === undefined || (Array.isArray(to) && !to.length)) return field.many === true ? [] : null;
  const list = (Array.isArray(to) ? to : [to]).map((u) => ({ urn: String(u) }));
  if (field.many !== true && list.length > 1) throw new Error(`${field.label || field.name} holds one record. Name one, or make the field a list.`);
  return field.many === true ? list : list[0];
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function }} h */
export function registerLinkFields({ tool, obj, str, refuse, parseUrn }) {
  const admin = (/** @type {any} */ d) => { let role = null; try { role = d.gateway.members.roleOf(d.chain.hops[0].actor); } catch { /* none */ } if (role !== "owner" && role !== "admin") throw refuse("Only an owner or an admin adds a link. Ask one of them.", "not_allowed"); };

  tool("records.link.add", "Add a link to a record type that shows on both ends: { type, label, to, many?, inverse_label? }. `to` is the type it links to; the other type gets the inverse (named inverse_label, else the plural of this type's name). `many` makes it a list. An owner's or admin's act, like records.define.",
    obj({ space: str, type: str, label: str, to: str, many: { type: "boolean" }, inverse_label: str, required: { type: "boolean" } }, ["type", "label", "to"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      admin(d);
      const defs = (await d.gateway.definitions(d.chain)) || [];
      const t = defs.find((/** @type {any} */ x) => x.name === i.type);
      if (!t) throw refuse(`There is no record type called ${i.type}. Pick one of the types shown in Records.`, "not_found");
      let field; try { field = linkFieldFrom(i, t, defs); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      await d.gateway.records.define(d.chain, { change_types: [{ ...t, fields: [...t.fields, field] }] });
      const stored = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === i.type);
      const made = stored && (stored.fields || []).find((/** @type {any} */ f) => f.name === field.name);
      return { field: made || field };
    });

  tool("records.link.set", "Connect a record through one of its link fields: { urn, field, to, kind? }. `to` is a record urn (a list of urns for a list field; null clears it). With `kind` (one of records.relationship.kinds) the connection is also kept as a relationship, so it keeps its kind and dates and shows on both records.",
    obj({ space: str, urn: str, field: str, to: { type: ["string", "array", "null"] }, kind: str }, ["urn", "field"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const u = parseUrn(i.urn);
      const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === u.type);
      const field = t && (t.fields || []).find((/** @type {any} */ f) => f.name === i.field && f.kind === "link");
      if (!field) throw refuse(`${u.type} has no link field called ${i.field}. records.link.add makes one.`, "not_found");
      let value; try { value = linkValue(field, i.to === undefined ? null : i.to); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      const targets = (Array.isArray(value) ? value : value ? [value] : []).map((/** @type {any} */ v) => String(v.urn));
      for (const target of targets) {
        const p = parseUrn(target);
        if (field.to && p.type !== field.to) throw refuse(`${field.label || field.name} links to a ${field.to}, not a ${p.type}.`, "bad_input");
        if (!(await d.gateway.records.get(d.chain, p.type, p.id))) throw refuse(`${target} is not here, or you may not read it. Pick a record you can see in Records.`, "not_found");
      }
      const rec = await d.gateway.records.get(d.chain, u.type, u.id);
      if (!rec) throw refuse(`${i.urn} is not here, or you may not read it. Pick a record you can see in Records.`, "not_found");
      let kinds = null;
      if (i.kind !== undefined && targets.length) {
        const rt = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === "relationship");
        kinds = rt && (rt.fields || []).find((/** @type {any} */ f) => f.name === "kind");
        if (!kinds) throw refuse("This Space has no relationship type yet. Ask an owner or admin to open Records once; it is made then.", "not_found");
        if (Array.isArray(kinds.options) && !kinds.options.includes(i.kind)) throw refuse(`${i.kind} is not one of this Space's relationship kinds: ${kinds.options.join(", ")}.`, "bad_input");
      }
      const out = await d.gateway.records.update(d.chain, u.type, u.id, { [field.name]: value }, rec.version);
      const relationships = [];
      if (kinds) for (const target of targets) relationships.push(await d.gateway.records.create(d.chain, "relationship", { from_record: String(i.urn), to_record: target, kind: i.kind }));
      return { record: out, ...(relationships.length ? { relationships } : {}) };
    }, (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space }));
}
