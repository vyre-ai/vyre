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
    const p = s.probability;
    if (p !== undefined && p !== null && p !== "" && (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100)) throw new Error(`Stage ${name}: the chance is a number from 0 to 100.`);
    return { name, ...(typeof p === "number" ? { probability: p } : {}), ...(req.length ? { enter_if: conditionOf(req) } : {}) };
  });
}

/**
 * Several pipelines on one type (a Sales pipeline and a Partner pipeline of deals): the first is the default, the others are stage sets picked by the record's `pipeline` field. Returns the default
 * stages, the other sets and every pipeline name. Throws a plain sentence. @param {any[]} pipelines [{ name, stages }] @param {Set<string>} fieldNames
 */
export function pipelinesFrom(pipelines, fieldNames) {
  if (!Array.isArray(pipelines) || !pipelines.length || pipelines.length > 10) throw new Error("A type has between 1 and 10 pipelines.");
  const seen = new Set();
  const built = pipelines.map((p) => {
    const name = String(p && p.name || "").trim();
    if (!name || name.length > 60 || /["\\]/.test(name)) throw new Error("Every pipeline needs a name of up to 60 characters, without quotes.");
    if (seen.has(name.toLowerCase())) throw new Error(`Two pipelines are called ${name}.`);
    seen.add(name.toLowerCase());
    return { name, stages: stagesFrom(p.stages, fieldNames) };
  });
  return { names: built.map((p) => p.name), stages: built[0].stages, stage_sets: built.slice(1).map((p) => ({ name: p.name, when: `pipeline == "${p.name}"`, stages: p.stages })), options: [...new Set(built.flatMap((p) => p.stages.map((s) => s.name)))] };
}

/** The stage list a record follows: the set named by its `pipeline` value, else the type's default stages. @param {any} t @param {Record<string, any>} data */
export function stagesOfRecord(t, data) {
  const set = (t.stage_sets || []).find((/** @type {any} */ s) => s.name === (data && data.pipeline));
  return set ? set.stages || [] : t.stages || [];
}

/** Which of the stage's required fields the record would still lack after this patch. @param {any} stage @param {Record<string, any>} data @param {Record<string, any>} patch */
export function missingFor(stage, data, patch) {
  const merged = { ...data, ...patch };
  const empty = (/** @type {any} */ v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
  return requiresOf(stage && stage.enter_if).filter((f) => empty(merged[f]));
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function, parseUrn: Function, update: (d: any, u: any, patch: any, base: number) => Promise<any> }} h */
export function registerPipeline({ tool, obj, str, refuse, parseUrn, update }) {
  const typeOf = async (/** @type {any} */ d, /** @type {string} */ name) => {
    const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === name);
    if (!t) throw refuse(`There is no record type called ${name}. Pick one of the types shown in Records.`, "not_found");
    return t;
  };
  tool("records.pipeline.set", "Set the stages of a record type for people who do not write conditions: { type, stages: [{ name, requires?: [field], lost?: true }] }. A stage with `requires` can only be entered once those fields are filled in; a `lost` stage needs a lost_reason. The type gets a Stage field and a Lost reason field when it has none. Who may change a type is the kernel's to decide.",
    obj({ space: str, type: str, stages: { type: "array", items: { type: "object" } }, pipelines: { type: "array", items: { type: "object" } } }, ["type"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const t = await typeOf(d, String(i.type));
      const fields = [...(t.fields || [])];
      // one list of stages, or several pipelines [{ name, stages }]: the first is the default and a record picks another with its `pipeline` field
      const lists = Array.isArray(i.pipelines) ? i.pipelines.map((/** @type {any} */ p) => (p && p.stages) || []) : [i.stages || []];
      const hasLost = lists.some((/** @type {any[]} */ l) => l.some((s) => s && (s.lost || (Array.isArray(s.requires) && s.requires.includes(LOST_REASON)))));
      if (hasLost && !fields.some((f) => f.name === LOST_REASON)) fields.push({ name: LOST_REASON, kind: "text", label: "Lost reason" });
      let built;
      try { built = Array.isArray(i.pipelines) ? pipelinesFrom(i.pipelines, new Set(fields.map((f) => f.name))) : (() => { const stages = stagesFrom(i.stages, new Set(fields.map((f) => f.name))); return { names: [], stages, stage_sets: [], options: stages.map((s) => s.name) }; })(); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      // setting just the default stages keeps the other pipelines as they are, and the stage field still offers their stages
      if (!Array.isArray(i.pipelines)) built.options = [...new Set([...built.options, ...(t.stage_sets || []).flatMap((/** @type {any} */ x) => (x.stages || []).map((/** @type {any} */ st) => st.name))])];
      const sf = fields.find((f) => f.kind === "stage");
      if (sf) fields[fields.indexOf(sf)] = { ...sf, options: built.options };
      else fields.push({ name: "stage", kind: "stage", label: "Stage", options: built.options });
      if (built.names.length > 1) {
        const pf = fields.find((f) => f.name === "pipeline");
        if (pf) fields[fields.indexOf(pf)] = { ...pf, kind: "choice", options: built.names };
        else fields.push({ name: "pipeline", kind: "choice", label: "Pipeline", options: built.names });
      }
      await d.gateway.records.define(d.chain, { change_types: [{ ...t, fields, stages: built.stages, ...(built.stage_sets.length ? { stage_sets: built.stage_sets } : Array.isArray(i.pipelines) ? { stage_sets: [] } : {}) }] });
      const shape = (/** @type {any[]} */ l) => l.map((s) => ({ name: s.name, ...(typeof s.probability === "number" ? { probability: s.probability } : {}), requires: requiresOf(s.enter_if), lost: isLost(s) }));
      return { type: t.name, stages: shape(built.stages), ...(built.names.length > 1 ? { pipelines: [{ name: built.names[0], stages: shape(built.stages) }, ...built.stage_sets.map((/** @type {any} */ s) => ({ name: s.name, stages: shape(s.stages) }))] } : {}) };
    });
  tool("records.move", "Move a record to a stage of its pipeline: { urn, stage, lost_reason?, patch? }. When the stage needs fields that are still empty the answer is { needs: [field names] } and nothing is written; fill them (patch can carry them) and move again. A lost stage needs lost_reason.",
    obj({ urn: str, stage: str, lost_reason: str, patch: { type: "object" } }, ["urn", "stage"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const u = parseUrn(i.urn);
      const t = await typeOf(d, u.type);
      const sf = (t.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
      if (!sf) throw refuse(`${t.label || t.name} has no stages. records.pipeline.set gives it some.`, "bad_input");
      const rec0 = await d.gateway.records.get(d.chain, u.type, u.id);
      const target = stagesOfRecord(t, (rec0 && rec0.data) || {}).find((/** @type {any} */ s) => s.name === i.stage) || [...(t.stages || []), ...(t.stage_sets || []).flatMap((/** @type {any} */ x) => x.stages)].find((/** @type {any} */ s) => s.name === i.stage);
      if (!target && !(sf.options || []).includes(i.stage)) throw refuse(`${t.label || t.name} has no stage called ${i.stage}. Its stages are: ${(sf.options || []).join(", ")}.`, "bad_input");
      const rec = await d.gateway.records.get(d.chain, u.type, u.id);
      if (!rec) throw refuse("That record is not here, or you may not read it. Pick one you can see in Records.", "not_found");
      let patch = { ...(i.patch && typeof i.patch === "object" ? i.patch : {}), ...(i.lost_reason !== undefined ? { [LOST_REASON]: String(i.lost_reason) } : {}), [sf.name]: i.stage };
      // a stage with a chance sets it, unless the move names one; the weighted value follows
      if (target && typeof target.probability === "number" && (t.fields || []).some((/** @type {any} */ f) => f.name === "probability") && !("probability" in patch)) patch = { ...patch, probability: target.probability };
      const needs = target ? missingFor(target, rec.data || {}, patch) : [];
      if (needs.length) return { needs, stage: i.stage };
      return update(d, u, patch, rec.version);
    }, (/** @type {any} */ i) => ({ space: parseUrn(i.urn).space }));
}
