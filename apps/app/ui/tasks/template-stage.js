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
