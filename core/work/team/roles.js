// @ts-check
// A Kit's role template becomes a teammate spec (contract 9.4, "Teammates", R6-10). Pure: no kernel call, so the add card can be drawn from it
// before anything is created. Text that came with a Kit (instructions, templates) is `external` until a person reviewed it, and says so on the card.

import { externalLabels, memberLabels } from "../../../lib/labels.js";

/** An assistant that can add teammates may add at most this many to one project (R6-10). */
export const MAX_ASSISTANT_ADDED = 5;

/** Risk of the actions teammates are usually given. An action not listed reads as `outward.share` (invariant 1). */
const KNOWN = Object.freeze({
  "records.read": "read", "records.update": "write", "memory.read": "read", "tasks.request": "write", "events.read": "read", "model.use": "read",
  "email.send": "outward.send", "payment.make": "outward.pay", "page.publish": "outward.publish", "record.share": "outward.share", "record.delete": "outward.delete",
});

/** @param {string} action @param {Readonly<Record<string, string>>} [registry] */
export const riskOf = (action, registry = KNOWN) => /** @type {any} */ (registry)[action] || "outward.share";

/** @param {string} action @param {Readonly<Record<string, string>>} [registry] */
export const isOutward = (action, registry = KNOWN) => riskOf(action, registry).startsWith("outward.");

/** @param {string} s */
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "teammate";
/** @param {string} s @param {number} n */
const cap = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);

/**
 * @typedef {{ name: string, instructions?: string, templates?: readonly { name: string, kind?: string, body: string }[], wanted?: readonly { actions: readonly string[], prefix?: string }[] }} KitRole
 * @typedef {{ name: string, role: string, project: string, space: string, instructions: { text: string, labels: import("../../../lib/labels.js").Labels, reviewed: boolean, reviewed_by?: string },
 *   templates: { name: string, kind: string, body: string, labels: import("../../../lib/labels.js").Labels, reviewed: boolean }[], wanted: { actions: string[], prefix: string }[], outward: string[] }} TeammateSpec
 */

const KIT_VERBS = { read: "records.read", write: "records.update", create: "records.create" };
/**
 * A Kit role's grants (`{ read: "matter" }`, `{ write: "matter.practice_area" }`, `{ create: "note" }`) as wanted entries: one per type and verb. A field-limited
 * grant is carried as the type with its `fields` named, because the gateway grants by type: the add card shows the fields and the kernel does not yet enforce them.
 * @param {readonly Record<string, string>[]} grants @param {string} space
 */
export function kitGrants(grants, space) {
  /** @type {Map<string, { actions: string[], prefix: string, fields?: string[] }>} */ const by = new Map();
  for (const g of grants || []) for (const [verb, target] of Object.entries(g)) {
    const action = /** @type {any} */ (KIT_VERBS)[verb];
    if (!action || typeof target !== "string") continue;
    const [type, field] = target.split(".");
    const key = `${action}\0${type}`;
    const e = by.get(key) || { actions: [action], prefix: `vyre://${space}/${type}/*` };
    if (field) e.fields = [...(e.fields || []), field];
    by.set(key, e);
  }
  return [...by.values()];
}

/**
 * A teammate spec from a Kit's role. Kit text is external and unreviewed; the spec lists any outward action it wants so the card can say so.
 * @param {KitRole} kitRole @param {{ project: string, space: string, registry?: Record<string, string> }} o @returns {TeammateSpec}
 */
export function teammateFromRole(kitRole, { project, space, registry }) {
  if (!kitRole || !kitRole.name) throw Object.assign(new Error("a role has a name"), { code: "bad_input" });
  const wanted = (kitRole.wanted || (/** @type {any} */ (kitRole)).grants ? (kitRole.wanted || kitGrants(/** @type {any} */ (kitRole).grants, space)) : []).map(w => ({ actions: [...w.actions], prefix: w.prefix || project, ...(w.fields ? { fields: w.fields } : {}) }));
  const outward = [...new Set(wanted.flatMap(w => w.actions).filter(a => isOutward(a, registry)))];
  return {
    name: slug(kitRole.name), role: cap(kitRole.name, 60), project, space,
    instructions: { text: cap(kitRole.instructions || "", 4000), labels: externalLabels(space), reviewed: false },
    templates: (kitRole.templates || []).slice(0, 20).map(t => ({ name: cap(t.name, 60), kind: cap(t.kind || "email", 20), body: cap(t.body, 8000), labels: externalLabels(space), reviewed: false })),
    wanted, outward,
  };
}

/** A person read the Kit text: it now carries the standing of a person's text, and the card says who reviewed it. @param {TeammateSpec} spec @param {string} person @returns {TeammateSpec} */
export function markReviewed(spec, person) {
  return { ...spec, instructions: { ...spec.instructions, labels: memberLabels(spec.space), reviewed: true, reviewed_by: person },
    templates: spec.templates.map(t => ({ ...t, labels: memberLabels(spec.space), reviewed: true })) };
}

/**
 * May this adder add this teammate now? An assistant adder is capped at 5 per project and can never add a teammate with outward powers
 * without a person (R6-10). A person adds freely here: the grants ceiling is delegate.js's.
 * @param {{ spec: TeammateSpec, adder: { kind: string, id: string }, count: number, humanApproved?: boolean }} o
 * @returns {{ ok: boolean, reason?: "cap"|"needs_human", detail?: string }}
 */
export function checkAdd({ spec, adder, count, humanApproved = false }) {
  if (adder.kind === "person") return { ok: true };
  if (count >= MAX_ASSISTANT_ADDED) return { ok: false, reason: "cap", detail: `an assistant adds at most ${MAX_ASSISTANT_ADDED} teammates to a project` };
  if (spec.outward.length && !humanApproved) return { ok: false, reason: "needs_human", detail: `${spec.role} would be able to ${spec.outward.join(", ")}: a person adds a teammate with outward powers` };
  return { ok: true };
}

/**
 * What the add card shows: the role, what it may do, and which text is unreviewed Kit text.
 * @param {TeammateSpec} spec
 */
export function addCardData(spec) {
  return {
    title: `Add ${spec.role}`, project: spec.project,
    wants: spec.wanted.map(w => ({ actions: w.actions, prefix: w.prefix, ...(/** @type {any} */ (w).fields ? { fields: /** @type {any} */ (w).fields } : {}) })),
    outward: spec.outward,
    kit_text: { instructions: { quoted: spec.instructions.text, label: spec.instructions.labels.trust, reviewed: spec.instructions.reviewed },
      templates: spec.templates.map(t => ({ name: t.name, label: t.labels.trust, reviewed: t.reviewed })) },
    unreviewed: !spec.instructions.reviewed || spec.templates.some(t => !t.reviewed),
  };
}

/** Plain words for the actions a teammate is usually given. */
const WORDS = Object.freeze({
  "records.read": "read this project", "records.update": "write notes and fill fields", "memory.read": "recall what the project knows", "tasks.request": "hand out tasks",
  "events.read": "read the project's history", "model.use": "think with an AI model", "email.send": "send email (each send is approved by a person)",
  "payment.make": "make payments (each one is approved by a person)", "page.publish": "publish pages (each one is approved by a person)",
});

/** @param {string} id */
const nice = id => id.charAt(0).toUpperCase() + id.slice(1);

/**
 * What the team card says about each teammate, in plain words: what it may do and why ("Research can read this project and write notes, because
 * Alice added it"). Built from the grants the kernel holds, never from the teammate's own words.
 * @param {readonly { name: string, role: string, adder: { id: string, name?: string }, grants: readonly { actions: readonly string[], conditions?: any }[], paused?: boolean }[]} team
 */
export function teamCard(team) {
  return team.map(m => {
    const acts = [...new Set(m.grants.flatMap(g => [...g.actions]))];
    const may = acts.map(a => /** @type {any} */ (WORDS)[a] || `use ${a}`);
    const needs = m.grants.some(g => g.conditions?.how?.presence && g.conditions.how.presence !== "none") ? "Some of what it does needs the person who added it to confirm first." : null;
    const who = nice(m.adder.name || m.adder.id);
    const list = may.length > 1 ? `${may.slice(0, -1).join(", ")} and ${may.at(-1)}` : may[0] || "do nothing yet";
    return { name: m.name, role: m.role, paused: Boolean(m.paused), may,
      line: `${m.role} can ${list}, because ${who} added it.`, ...(needs ? { note: needs } : {}), ...(m.paused ? { paused_reason: `${who} no longer holds what ${m.role} was given, so ${m.role} is paused.` } : {}) };
  });
}
