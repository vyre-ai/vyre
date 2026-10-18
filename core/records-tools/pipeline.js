// @ts-check
// Pipelines for any record type, for people who do not write expressions: a stage names the fields it needs filled in (`requires`) and may be a lost stage (which needs a reason). The kernel already
// enforces a stage's entry condition (`enter_if`, stage_entry_refused); this file turns the plain list into that condition and back, and gives the move a friendly answer: `needs: [fields]` and nothing written.
// Pure helpers first, the two tools after (records.pipeline.set, records.move), registered by index.js.

export const LOST_REASON = "lost_reason";
const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The entry condition for a stage that needs these fields. @param {string[]} fields */
export const conditionOf = (fields) => fields.map((f) => `not empty(${f})`).join(" and ");

/** The fields a stored entry condition asks for (only conditions this file wrote; anything else reads as none, so a hand-written condition is left to the kernel). @param {string | undefined} cond */
export function requiresOf(cond) {
  if (typeof cond !== "string" || !cond.trim()) return [];
  const parts = cond.split(" and ").map((p) => /^not empty\(([a-z][a-z0-9_]*)\)$/.exec(p.trim()));
  return parts.every(Boolean) ? parts.map((m) => /** @type {RegExpExecArray} */ (m)[1]) : [];
}

/** Is this a lost stage: one whose entry asks for the lost reason. @param {{ enter_if?: string }} stage */
export const isLost = (stage) => requiresOf(stage.enter_if).includes(LOST_REASON);

/** A person's stage list, as the type's stages. Checks names and fields; throws a plain sentence. @param {any[]} stages @param {Set<string>} fieldNames */
export function stagesFrom(stages, fieldNames) {
  if (!Array.isArray(stages) || !stages.length || stages.length > 30) throw new Error("A pipeline has between 1 and 30 stages.");
  const seen = new Set();
  return stages.map((s) => {
    const name = String(s && s.name || "").trim();
    if (!name || name.length > 60) throw new Error("Every stage needs a name of up to 60 characters.");
    if (seen.has(name.toLowerCase())) throw new Error(`Two stages are called ${name}.`);
    seen.add(name.toLowerCase());
    const req = [...new Set([...(Array.isArray(s.requires) ? s.requires.map(String) : []), ...(s.lost ? [LOST_REASON] : [])])];
    for (const f of req) {
      if (!NAME.test(f)) throw new Error(`${f} is not a field name.`);
      if (f !== LOST_REASON && !fieldNames.has(f)) throw new Error(`Stage ${name} asks for ${f}, which this type does not have.`);
    }
    return { name, ...(req.length ? { enter_if: conditionOf(req) } : {}) };
  });
}

/** Which of the stage's required fields the record would still lack after this patch. @param {any} stage @param {Record<string, any>} data @param {Record<string, any>} patch */
export function missingFor(stage, data, patch) {
  const merged = { ...data, ...patch };
  const empty = (/** @type {any} */ v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
  return requiresOf(stage && stage.enter_if).filter((f) => empty(merged[f]));
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function }} h */
export function registerPipeline({ tool, obj, str, refuse, parseUrn }) {
  const typeOf = async (/** @type {any} */ d, /** @type {string} */ name) => {
    const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === name);
    if (!t) throw refuse(`There is no record type called ${name}. records.types lists them.`, "not_found");
    return t;
  };
  tool("records.pipeline.set", "Set the stages of a record type for people who do not write conditions: { type, stages: [{ name, requires?: [field], lost?: true }] }. A stage with `requires` can only be entered once those fields are filled in; a `lost` stage needs a lost_reason. The type gets a Stage field and a Lost reason field when it has none. Who may change a type is the kernel's to decide.",
    obj({ space: str, type: str, stages: { type: "array", items: { type: "object" } } }, ["type", "stages"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const t = await typeOf(d, String(i.type));
      const fields = [...(t.fields || [])];
      const hasLost = (i.stages || []).some((/** @type {any} */ s) => s && s.lost) || (i.stages || []).some((/** @type {any} */ s) => Array.isArray(s && s.requires) && s.requires.includes(LOST_REASON));
      if (hasLost && !fields.some((f) => f.name === LOST_REASON)) fields.push({ name: LOST_REASON, kind: "text", label: "Lost reason" });
      let stages;
      try { stages = stagesFrom(i.stages, new Set(fields.map((f) => f.name))); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      let sf = fields.find((f) => f.kind === "stage");
      const options = stages.map((s) => s.name);
      if (sf) fields[fields.indexOf(sf)] = { ...sf, options };
      else fields.push({ name: "stage", kind: "stage", label: "Stage", options });
      await d.gateway.records.define(d.chain, { change_types: [{ ...t, fields, stages, stage_sets: undefined }] });
      return { type: t.name, stages: stages.map((s) => ({ name: s.name, requires: requiresOf(s.enter_if), lost: isLost(s) })) };
    });
  tool("records.move", "Move a record to a stage of its pipeline: { urn, stage, lost_reason?, patch? }. When the stage needs fields that are still empty the answer is { needs: [field names] } and nothing is written; fill them (patch can carry them) and move again. A lost stage needs lost_reason.",
    obj({ urn: str, stage: str, lost_reason: str, patch: { type: "object" } }, ["urn", "stage"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const u = parseUrn(i.urn);
      const t = await typeOf(d, u.type);
      const sf = (t.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
      if (!sf) throw refuse(`${t.label || t.name} has no stages. records.pipeline.set gives it some.`, "bad_input");
      const target = [...(t.stages || []), ...(t.stage_sets || []).flatMap((/** @type {any} */ x) => x.stages)].find((/** @type {any} */ s) => s.name === i.stage);
      if (!target && !(sf.options || []).includes(i.stage)) throw refuse(`${t.label || t.name} has no stage called ${i.stage}. Its stages are: ${(sf.options || []).join(", ")}.`, "bad_input");
      const rec = await d.gateway.records.get(d.chain, u.type, u.id);
      if (!rec) throw refuse("That record is not here, or you may not read it. records.list shows the ones you can.", "not_found");
      const patch = { ...(i.patch && typeof i.patch === "object" ? i.patch : {}), ...(i.lost_reason !== undefined ? { [LOST_REASON]: String(i.lost_reason) } : {}), [sf.name]: i.stage };
      const needs = target ? missingFor(target, rec.data || {}, patch) : [];
      if (needs.length) return { needs, stage: i.stage };
      return { record: await d.gateway.records.update(d.chain, u.type, u.id, patch, rec.version) };
    }, (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space }));
}
