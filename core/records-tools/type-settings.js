// @ts-check
// How a type presents itself, kept on the type: its colour, whether Records leaves it out of its own list (Files, Templates and Playbooks have screens of their own), and the colours of a choice or stage field's
// options. Presentation only, never a permission. records.type.update { name, label?, color?, hidden_in_records?, option_colors? }; the stages, chances and pipelines are records.pipeline.set.

export const COLOUR_NAMES = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const HEX = /^#[0-9a-fA-F]{6}$/;
/** @param {unknown} c */
export const isColour = (c) => typeof c === "string" && (COLOUR_NAMES.includes(c) || HEX.test(c));

/**
 * The type with the changes applied, or a plain sentence thrown. option_colors is { field: { option: colour } } and replaces that field's colours (null clears them); a field must be a choice or stage field
 * and an option one of its options.
 * @param {any} t @param {{ label?: any, color?: any, hidden_in_records?: any, option_colors?: any }} i
 */
export function applyTypeSettings(t, i) {
  const out = { ...t };
  if (i.label !== undefined) {
    const label = String(i.label).trim();
    if (!label || label.length > 60) throw new Error("A type's name is 1 to 60 characters.");
    out.label = label;
  }
  if (i.color !== undefined) {
    if (i.color === null || i.color === "") delete out.color;
    else if (isColour(i.color)) out.color = i.color;
    else throw new Error(`A colour is one of ${COLOUR_NAMES.join(", ")} or a hex like #3b82f6.`);
  }
  if (i.hidden_in_records !== undefined) {
    if (typeof i.hidden_in_records !== "boolean") throw new Error("hidden_in_records is true or false.");
    if (i.hidden_in_records) out.hidden_in_records = true; else delete out.hidden_in_records;
  }
  if (i.option_colors !== undefined) {
    if (!i.option_colors || typeof i.option_colors !== "object" || Array.isArray(i.option_colors)) throw new Error("option_colors is { field: { option: colour } }.");
    const all = { ...(t.option_colors || {}) };
    for (const [fname, map] of Object.entries(i.option_colors)) {
      const f = (t.fields || []).find((/** @type {any} */ x) => x.name === fname);
      if (!f || !["choice", "stage"].includes(f.kind)) throw new Error(`${fname} is not a choice or stage field of ${t.label || t.name}.`);
      if (map === null) { delete all[fname]; continue; }
      if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error(`${fname}: give { option: colour }.`);
      for (const [opt, c] of Object.entries(/** @type {Record<string, any>} */ (map))) {
        if (!(f.options || []).includes(opt)) throw new Error(`${opt} is not one of ${fname}'s options: ${(f.options || []).join(", ")}.`);
        if (!isColour(c)) throw new Error(`${opt}: a colour is one of ${COLOUR_NAMES.join(", ")} or a hex like #3b82f6.`);
      }
      all[fname] = map;
    }
    if (Object.keys(all).length) out.option_colors = all; else delete out.option_colors;
  }
  return out;
}

/** The presentation of a type, as the screens read it. @param {any} t */
export const settingsOf = (t) => ({ name: t.name, label: t.label, color: t.color || null, hidden_in_records: t.hidden_in_records === true, option_colors: t.option_colors || {} });

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function }} h */
export function registerTypeSettings({ tool, obj, str, refuse }) {
  tool("records.type.update", "Change how a record type presents itself: { name, label?, color?, hidden_in_records?, option_colors? }. color is a name (gray, red, orange, yellow, green, teal, blue, purple, pink) or a hex; hidden_in_records keeps the type out of Records' own list (Files, Templates and Playbooks have screens of their own); option_colors is { field: { option: colour } } for a choice or stage field. The stages, chances and pipelines are records.pipeline.set. An owner's or admin's act, like records.define.",
    obj({ space: str, name: str, label: str, color: str, hidden_in_records: { type: "boolean" }, option_colors: { type: "object" } }, ["name"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === i.name);
      if (!t) throw refuse(`There is no record type called ${i.name}. Pick one of the types shown in Records.`, "not_found");
      let next; try { next = applyTypeSettings(t, i); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      await d.gateway.records.define(d.chain, { change_types: [next] });
      return { type: settingsOf(next) };
    });
}
