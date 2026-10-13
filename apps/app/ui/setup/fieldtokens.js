// @ts-check
// The pure half of the field list's tokens: for each field of an object, the {object.field} a person types in a template, its bare key, and for a link field the nested form.
// The tokens come from the Flows composer's own insert list (flows/template.js insertList), so they are the same text the composer shows and Documents placeholders use.
import { insertList } from "../flows/template.js";
import { sectionsOf } from "../components/groups.js";

/** @typedef {{ name: string, label: string, kind?: string, group?: string, to?: string, many?: boolean }} Field */
/** @typedef {{ name: string, label: string, fields: Field[], groups?: { name: string }[] }} Def */
/** @typedef {{ key: string, token: string, nested?: { form: string, target: string } }} FieldToken  `nested`: a link field's reach into the object it points to, as `{object.link.field}`, and that object's label */

/** The token of every field of an object, by field name. @param {Def} def @param {Def[]} types */
export function fieldTokens(def, types) {
  /** @type {Record<string, FieldToken>} */ const out = {};
  const groups = insertList({ trigger: { kind: "created", type: def.name }, steps: [] }, "", { types }, {});
  const items = groups[0]?.items ?? [];
  for (const f of def.fields) {
    const own = items.find((i) => /^\{[^.}]+\.[^.}]+\}$/.test(i.alias) && i.alias.endsWith(`.${f.name}}`));
    const prefix = items.length ? items[0].alias.slice(0, items[0].alias.indexOf(".") + 1) : "";
    if (own) { out[f.name] = { key: f.name, token: own.alias }; continue; }
    // a link field has no token of its own; its fields are the items that go through it: {object.link.field}
    const through = items.find((i) => prefix && i.alias.startsWith(`${prefix}${f.name}.`));
    if (through) {
      const target = types.find((t) => t.name === f.to);
      out[f.name] = { key: f.name, token: "", nested: { form: `${through.alias.slice(0, through.alias.lastIndexOf("."))}.field}`, target: target?.label ?? f.to ?? "" } };
    }
  }
  return out;
}

/** The fields in the sections an object shows them in (the default section first, then each group in order), each with its token. @param {Def} def @param {Def[]} types */
export function groupedTokens(def, types) {
  const tokens = fieldTokens(def, types);
  const fields = def.fields.filter((f) => f.kind !== "stage" && tokens[f.name]);
  return sectionsOf(def.groups ?? [], fields).map((s) => ({ group: s.name, rows: s.items.map((f) => ({ label: f.label, ...tokens[f.name] })) }));
}

/** A plain list of label and token pairs, one per line, under a heading for each group. Link fields are left out; their nested form is a rule, not a value. @param {Def} def @param {Def[]} types */
export function tokenList(def, types) {
  const secs = groupedTokens(def, types);
  const lines = [];
  for (const s of secs) {
    const rows = s.rows.filter((r) => r.token);
    if (!rows.length) continue;
    if (s.group) lines.push(`${lines.length ? "\n" : ""}${s.group}`);
    for (const r of rows) lines.push(`${r.label}: ${r.token}`);
  }
  return lines.join("\n");
}
