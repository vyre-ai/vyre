// @ts-check
// A project started from a template carries that version's stages (JSON in `template_snapshot`) and sits in one of them (`template_stage`, plain text). The Projects list reads them here, so a template
// project shows where it is like any other project that has stages.

/** The stages a template project follows and where it is now; null for a record that is not one. @param {any} data a project's fields @returns {{ stages: string[], at: number } | null} */
export function templateStage(data) {
  const text = data && typeof data.template_snapshot === "string" ? data.template_snapshot : "";
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const stages = Array.isArray(j && j.stages) ? j.stages.map((/** @type {any} */ s) => String(s && s.name)).filter(Boolean) : [];
    return stages.length ? { stages, at: stages.indexOf(String(data.template_stage ?? "")) } : null;
  } catch { return null; }
}

/** What a project of a template is called ("Matter"): the template's noun, else its name, else null for a project that started from none. @param {any} data a project's fields @returns {string | null} */
export function templateNoun(data) {
  const text = data && typeof data.template_snapshot === "string" ? data.template_snapshot : "";
  if (!text) return null;
  try { const j = JSON.parse(text); const w = String((j && j.noun && j.noun.one) || (j && j.name) || ""); return w || null; } catch { return null; }
}

/**
 * The New menu's choices: each template's own ("New matter", then "New blank project"), then a "New <type>" for every record type that holds work, except the plain Project (the template choices stand for it) and
 * any type whose label a template choice already says (a record type called Matter next to a template whose projects are Matters). @param {{ name: string, label: string }[]} types
 * @param {{ label: string, key: string | null }[] | undefined} choices @returns {{ label: string, type?: string, key?: string | null }[]}
 */
export function newMenuItems(types, choices) {
  const said = new Set((choices || []).map((c) => c.label.toLowerCase()));
  return [
    ...(choices || []).map((c) => ({ label: c.label, key: c.key })),
    ...types.filter((t) => !(choices && t.name === "project") && !said.has(`new ${t.label.toLowerCase()}`)).map((t) => ({ label: `New ${t.label.toLowerCase()}`, type: t.name })),
  ];
}
