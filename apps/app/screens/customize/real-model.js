// @ts-check
// Customize on a real vyred: the kernel's TypeDefinition (kernel/contracts/fields.d.ts) as the screen's TypeDef and back. A change is sent as one
// records.define diff (change_types for an existing type, add_types for a new one), so the vyred, not the screen, decides what is allowed.
import { pluralOf } from "./logic.js";

/** @typedef {import("./logic.js").TypeDef} TypeDef */

/** The kernel's own types (flow state, goals) are not the person's to customize. @param {any} t */
export const isOwn = (t) => !/^(def-|flow-|kit-proposal$|kit-install$|goal$)/.test(String(t.name)) && !t.internal;

/** One kernel type as the screen's. @param {any} t @param {string} space @returns {TypeDef} */
export function toTypeDef(t, space) {
  const stageField = (t.fields || []).find((/** @type {any} */ f) => f.kind === "stage");
  const stages = (t.stages || []).map((/** @type {any} */ s) => s.name).concat([]);
  const rules = Object.fromEntries((t.rules || []).filter((/** @type {any} */ r) => r.name).map((/** @type {any} */ r) => [r.name, r.require]));
  return {
    id: t.name, label: t.label, plural: pluralOf(t.label), spaces: [space], work: Boolean(stageField || stages.length), icon: t.icon,
    fields: (t.fields || []).map((/** @type {any} */ f) => ({ key: f.name, label: f.label, kind: f.kind, required: f.required || undefined, ...(f.visible_if || f.required_if ? { rule: [f.visible_if ? `shown when ${f.visible_if}` : null, f.required_if ? `required when ${f.required_if}` : null].filter(Boolean).join(", ") } : {}), sealed: f.kind === "sealed" || Boolean(f.seal) || undefined, ...(f.kind === "link" && f.to ? { to: f.to } : {}) })),
    stages: stages.length ? stages : (stageField?.options ?? []).slice(),
    ...(Object.keys(rules).length ? { rules } : {}),
  };
}

/** The screen's type applied onto the kernel's original, so what the screen does not show (tasks on a stage, expressions, uniqueness) is kept. @param {TypeDef} t @param {any} original */
export function toKernelType(t, original) {
  const byName = new Map((original?.fields || []).map((/** @type {any} */ f) => [f.name, f]));
  const fields = t.fields.map((f) => {
    const o = /** @type {any} */ (byName.get(f.key));
    const base = o ? { ...o, label: f.label } : { name: f.key.replace(/-/g, "_"), label: f.label, kind: f.kind, ...(f.required ? { required: true } : {}), ...(f.kind === "choice" ? { options: ["Option A", "Option B"] } : {}), ...(f.kind === "link" && f.to ? { to: f.to } : {}) };
    if (f.sealed && !base.seal) return { ...base, seal: { level: "ai", class: "free" } };
    if (!f.sealed && base.seal && base.kind !== "sealed") { const { seal: _s, ...rest } = base; return rest; }
    return base;
  });
  const oldStages = new Map((original?.stages || []).map((/** @type {any} */ s) => [s.name, s]));
  const stages = t.stages.map((n) => oldStages.get(n) ?? { name: n });
  return { ...(original ?? {}), name: t.id, label: t.label, ...(t.icon ? { icon: t.icon } : {}), fields, ...(stages.length ? { stages } : {}) };
}

/** The records.define diff for one screen change. @param {TypeDef} t @param {any | undefined} original */
export function diffFor(t, original) {
  return original ? { change_types: [toKernelType(t, original)] } : { add_types: [toKernelType(t, undefined)] };
}
