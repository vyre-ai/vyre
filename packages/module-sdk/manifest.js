// @ts-check
// Check a module.json against module API 1 (ADR 0033, frozen by ADR 0047), with no dependencies.
//
// manifest.schema.json is the one definition of the manifest. checkSchema() is a small JSON Schema
// checker for the parts that schema uses (type, enum, pattern, properties, $ref and a few more),
// so a module author, `vyre module check` and the loader all give the same answer without pulling
// in a validator. checkManifest() adds the rules a schema can't say: a module's tools, settings,
// hooks and commands carry its own name, and an added module (one from outside the repo) keeps
// to the stricter half of ADR 0047: object tool entries, no person reach, no built in only keys.
//
// toolEntries(), capabilities() and widened() read what a module may do from the manifest alone,
// so the install card, the capability manifest and the loader can't disagree (ADR 0047 section 2:
// there is no hand-written capabilities key).

import fs from "node:fs";

/** The module API majors this Vyre loads. */
export const API_VERSIONS = [1];

/** Who may call a tool (ADR 0047 section 2). anyone is the default. */
export const REACHES = ["anyone", "asked", "person", "modules", "hook"];
/** The reaches an outward tool may have: only a person or an asking agent can start one. */
const OUTWARD_REACH = ["anyone", "asked"];
/** Manifest keys only Vyre's own modules may use in 0.2, each with where it lives. */
const BUILT_IN_ONLY = [["does", "providers"], ["shows", "streams"], ["needs", "vault"]];

/** @type {any} */
export const SCHEMA = JSON.parse(fs.readFileSync(new URL("./manifest.schema.json", import.meta.url), "utf8"));

const TYPES = {
  object: v => v !== null && typeof v === "object" && !Array.isArray(v),
  array: Array.isArray,
  string: v => typeof v === "string",
  number: v => typeof v === "number" && Number.isFinite(v),
  integer: Number.isInteger,
  boolean: v => typeof v === "boolean",
  null: v => v === null,
};

/** @param {any} root @param {string} ref */
const resolve = (root, ref) => {
  if (!ref.startsWith("#/")) throw new Error(`only local refs are supported: ${ref}`);
  return ref.slice(2).split("/").reduce((o, k) => o && o[k], root);
};

/**
 * Check a value against a schema. Returns problems as readable lines, empty when it passes.
 * @param {any} schema @param {any} value @param {string} [where] @param {any} [root]
 * @returns {string[]}
 */
export function checkSchema(schema, value, where = "manifest", root = schema) {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${where} is not allowed`];
  if (schema.$ref) return checkSchema(resolve(root, schema.$ref), value, where, root);
  const say = (/** @type {string} */ fallback) => `${where} ${schema["x-message"] || fallback}`;
  if (schema.anyOf) {
    const tries = schema.anyOf.map((/** @type {any} */ s) => checkSchema(s, value, where, root));
    if (tries.some((/** @type {string[]} */ t) => t.length === 0)) return [];
    // A branch of the value's own type says more than "must be string": an object tool entry
    // missing its name should say so, not that it isn't a name.
    const typed = tries.filter((/** @type {string[]} */ t) => !(t.length === 1 && t[0].startsWith(`${where} must be `) && /must be (object|array|string|number|integer|boolean|null)( or \w+)*$/.test(t[0])));
    return (typed.length ? typed : tries).reduce((/** @type {string[]} */ a, /** @type {string[]} */ b) => (b.length < a.length ? b : a));
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((/** @type {keyof TYPES} */ t) => TYPES[t] && TYPES[t](value))) return [`${where} must be ${types.join(" or ")}`];
  }
  if ("const" in schema && value !== schema.const) return [`${where} must be ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${where} must be one of ${schema.enum.join(", ")}`];
  /** @type {string[]} */
  const out = [];
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(say("is too short"));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(say("is too long"));
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(say(`must match ${schema.pattern}`));
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where} must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${where} needs at least ${schema.minItems}`);
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) out.push(`${where} has duplicates`);
    if (schema.items) value.forEach((v, i) => out.push(...checkSchema(schema.items, v, `${where}[${i}]`, root)));
  }
  if (TYPES.object(value)) {
    for (const k of schema.required || []) if (value[k] === undefined) out.push(`${where}.${k} is required`);
    const props = schema.properties || {};
    const patterns = Object.entries(schema.patternProperties || {}).map(([p, s]) => /** @type {[RegExp, any]} */ ([new RegExp(p), s]));
    for (const [k, v] of Object.entries(value)) {
      const at = `${where}.${k}`;
      if (schema.propertyNames) {
        const bad = checkSchema(schema.propertyNames, k, `${where} key "${k}"`, root);
        if (bad.length) { out.push(...bad); continue; }
      }
      if (k in props) { out.push(...checkSchema(props[k], v, at, root)); continue; }
      const matched = patterns.filter(([re]) => re.test(k));
      if (matched.length) { for (const [, s] of matched) out.push(...checkSchema(s, v, at, root)); continue; }
      if (schema.additionalProperties === false) out.push(`${at} is not a manifest key in module API 1`);
      else if (schema.additionalProperties !== undefined) out.push(...checkSchema(schema.additionalProperties, v, at, root));
    }
  }
  return out;
}

/**
 * Check a manifest: the schema, then the rules that need the module's name. A module from outside
 * Vyre (firstParty false, the default) is held to more: its settings can't be kept anywhere that
 * reaches past its own rows, because a person's change to a setting carries the person's authority.
 * @param {any} m
 * @param {{ firstParty?: boolean }} [opts]
 * @returns {string[]}
 */
export function checkManifest(m, { firstParty = false } = {}) {
  const out = checkSchema(SCHEMA, m);
  if (!TYPES.object(m) || typeof m.name !== "string") return out;
  const own = (/** @type {string} */ t) => t.startsWith(m.name + ".");
  const does = TYPES.object(m.does) ? m.does : {};
  const entries = Array.isArray(does.tools) ? does.tools : [];
  /** Every tool name, from either form: what the rest of the manifest may map to. */
  const tools = [];
  for (const t of entries) {
    const name = typeof t === "string" ? t : TYPES.object(t) && typeof t.name === "string" ? t.name : null;
    if (name === null) continue;
    if (!own(name)) out.push(`tool "${name}" must start with "${m.name}."`);
    else if (tools.includes(name)) out.push(`tool "${name}" is declared twice`);
    tools.push(name);
  }
  // An added module (ADR 0047): everything the install card shows is declared, and nothing reaches
  // past what a sandboxed host can offer in 0.2.
  if (!firstParty) {
    if (m.apiVersion === undefined) out.push(`apiVersion is required outside Vyre's own modules; add "apiVersion": ${API_VERSIONS[API_VERSIONS.length - 1]}`);
    if (m.description === undefined) out.push("description is required outside Vyre's own modules: one plain sentence for the install card");
    for (const t of entries) {
      if (typeof t === "string") { out.push(`tool "${t}" must be an object like { "name": "${t}", "summary": "...", "reach": "anyone" } in an added module`); continue; }
      if (!TYPES.object(t) || typeof t.name !== "string") continue;
      if (t.reach === "person") out.push(`tool "${t.name}": reach "person" is kept for Vyre's own tools; use "asked", which an agent reaches only when the person's own words asked for it`);
      if (t.outward !== undefined && !OUTWARD_REACH.includes(t.reach || "anyone")) out.push(`tool "${t.name}": an outward tool must have reach "anyone" or "asked", not "${t.reach}"`);
    }
    for (const [block, key] of BUILT_IN_ONLY) {
      const v = TYPES.object(m[block]) ? m[block][key] : undefined;
      if (Array.isArray(v) ? v.length : v !== undefined) out.push(`${block}.${key} is built in only in 0.2; an added module can't use it`);
    }
    if (Array.isArray(m.roles) && m.roles.length && m.roles.every((/** @type {string} */ r) => r === "windows")) out.push(`roles ["windows"] loads nowhere in 0.2: only the Mac has a local node yet; add "mac" or "box"`);
  }
  // Everything a manifest maps to a tool must be one this module registers itself.
  /** @type {[string, any][]} */
  const mapped = [
    ...Object.entries(TYPES.object(does.hooks) ? does.hooks : {}).map(([k, t]) => /** @type {[string, any]} */ ([`does.hooks.${k}`, t])),
    ...Object.entries(TYPES.object(does.senders) ? does.senders : {}).map(([k, t]) => /** @type {[string, any]} */ ([`does.senders.${k}`, t])),
    ...(Array.isArray(does.commands) ? does.commands : []).map((c, i) => /** @type {[string, any]} */ ([`does.commands[${i}]`, c && c.tool])),
    ...["connections", "suggest"].filter(k => does[k] !== undefined).map(k => /** @type {[string, any]} */ ([`does.${k}`, does[k]])),
    ...Object.entries(TYPES.object(does.apps) ? does.apps : {}).flatMap(([app, a]) =>
      Object.entries(TYPES.object(a) && TYPES.object(a.actions) ? a.actions : {}).map(([k, t]) => /** @type {[string, any]} */ ([`does.apps.${app}.actions.${k}`, t]))),
  ];
  for (const [where, t] of mapped) if (typeof t === "string" && !tools.includes(t)) out.push(`${where} names ${t}, which is not under does.tools`);
  // The same rules as the loader's settings check (core/config/settings.js validateDecls).
  const seen = new Set();
  for (const s of Array.isArray(m.settings) ? m.settings : []) {
    if (!s || typeof s.key !== "string") continue;
    if (!own(s.key)) out.push(`setting "${s.key}" must start with "${m.name}."`);
    if (seen.has(s.key)) out.push(`setting ${s.key} is declared twice`);
    seen.add(s.key);
    if (s.store && s.store.config !== undefined && Array.isArray(s.levels) && s.levels.includes("project")) out.push(`setting ${s.key}: a config.json setting is account only`);
    // ADR 0035: a device's value changes how a surface looks, never what Claude may do.
    if (Array.isArray(s.levels) && s.levels.includes("device") && (s.confirm !== undefined || s.security !== undefined)) out.push(`setting ${s.key}: a setting with confirm or security may not be set per device`);
    // Session level is a thread's chip, which only a module's own tool store keeps.
    if (Array.isArray(s.levels) && s.levels.includes("session") && !(TYPES.object(s.store) && s.store.tool !== undefined)) out.push(`setting ${s.key}: the session level needs a store in this module's own tools`);
    for (const f of ["check", "choicesFrom"]) {
      const name = TYPES.object(s[f]) ? s[f].tool : undefined;
      if (typeof name === "string" && !tools.includes(name)) out.push(`setting ${s.key}: ${f}.tool must be one of this module's own tools`);
    }
    if (firstParty || !TYPES.object(s.store)) continue;
    if (s.store.claude !== undefined) out.push(`setting ${s.key}: only Vyre's own modules may keep a setting in Claude Code's files`);
    if (typeof s.store.config === "string" && !own(s.store.config)) out.push(`setting ${s.key}: a config.json path must start with "${m.name}."`);
    const t = TYPES.object(s.store.tool) ? s.store.tool : {};
    for (const side of ["get", "set"]) {
      const name = TYPES.object(t[side]) ? t[side].tool : undefined;
      if (typeof name === "string" && !tools.includes(name)) out.push(`setting ${s.key}: store.tool.${side} must be one of this module's own tools`);
    }
  }
  // Tips are found by id, so an id names one tip in its module.
  const tipIds = new Set();
  for (const t of TYPES.object(m.teaches) && Array.isArray(m.teaches.tips) ? m.teaches.tips : []) {
    if (!t || typeof t.id !== "string") continue;
    if (tipIds.has(t.id)) out.push(`tip "${t.id}" is declared twice`);
    tipIds.add(t.id);
  }
  // A replacement registers the original's tools, so it carries the original's name; replaces
  // says so out loud, since a duplicate name without it is refused.
  if (typeof m.replaces === "string" && m.replaces !== m.name) out.push(`replaces is "${m.replaces}" but the module is named "${m.name}"; a replacement takes the name of the module it replaces`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// What a module may do, read from its manifest alone (ADR 0047 sections 2, 4 and 6)

/**
 * Every tool entry in one shape. A string entry is the built in grace form, so its reach is
 * anyone and it acts as no one outside.
 * @param {any} m
 * @returns {{ name: string, summary: string, reach: string, outward: string | null, cost: string | null }[]}
 */
export function toolEntries(m) {
  const list = TYPES.object(m) && TYPES.object(m.does) && Array.isArray(m.does.tools) ? m.does.tools : [];
  return list.flatMap((/** @type {any} */ t) => {
    if (typeof t === "string") return [{ name: t, summary: "", reach: "anyone", outward: null, cost: null }];
    if (!TYPES.object(t) || typeof t.name !== "string") return [];
    return [{ name: t.name, summary: typeof t.summary === "string" ? t.summary : "", reach: t.reach || "anyone", outward: t.outward || null, cost: t.cost || null }];
  });
}

/**
 * The install card's summary, computed from the manifest: never from a module's own words about
 * itself. Outward tools are listed apart, since those are the ones that act as the person.
 * @param {any} m
 */
export function capabilities(m) {
  const does = TYPES.object(m && m.does) ? m.does : {};
  const needs = TYPES.object(m && m.needs) ? m.needs : {};
  const shows = TYPES.object(m && m.shows) ? m.shows : {};
  const teaches = TYPES.object(m && m.teaches) ? m.teaches : {};
  const list = (/** @type {any} */ v) => (Array.isArray(v) ? v : []);
  /** @type {Record<string, { tool: string, summary: string, cost?: string }[]>} */
  const tools = Object.fromEntries(REACHES.map(r => [r, []]));
  /** @type {{ tool: string, kind: string, summary: string, reach: string, cost?: string }[]} */
  const outward = [];
  for (const t of toolEntries(m)) {
    const cost = t.cost ? { cost: t.cost } : {};
    if (t.outward) outward.push({ tool: t.name, kind: t.outward, summary: t.summary, reach: t.reach, ...cost });
    else (tools[t.reach] || (tools[t.reach] = [])).push({ tool: t.name, summary: t.summary, ...cost });
  }
  const called = list(needs.tools);
  return {
    tools, outward,
    hosts: [...list(needs.network)],
    credentials: list(needs.credentials).filter(TYPES.object).map((/** @type {any} */ c) => ({ id: c.id, kind: c.kind, provider: c.provider, purpose: c.purpose })),
    connections: list(needs.connections).filter(TYPES.object).map((/** @type {any} */ c) => ({ provider: c.provider, purpose: c.purpose })),
    spend: TYPES.object(needs.spend) && TYPES.number(needs.spend.dailyUsd) ? { dailyUsd: needs.spend.dailyUsd } : null,
    slots: [...list(shows.deck), ...list(does.commands).filter(TYPES.object).map((/** @type {any} */ c) => `command:${c.verb}`)],
    memory: { kinds: [...list(teaches.memory)], writes: called.includes("memory.write") || called.includes("memory.*") },
    runs: Array.isArray(m && m.roles) && m.roles.length ? [...m.roles] : ["box"],
  };
}

/**
 * What an update adds that the person hasn't granted: a new outward tool, host, credential,
 * connection or asked tool, or a higher spend cap. Empty means it installs quietly (ADR 0047
 * section 6); anything else shows the card again with only these lines.
 * @param {ReturnType<typeof capabilities>} before
 * @param {ReturnType<typeof capabilities>} after
 * @returns {{ kind: "outward" | "host" | "credential" | "connection" | "asked" | "spend", what: string, from?: number | null, to?: number }[]}
 */
export function widened(before, after) {
  /** @type {ReturnType<typeof widened>} */
  const out = [];
  const had = (/** @type {string[]} */ xs, /** @type {string} */ x) => xs.includes(x);
  const outBefore = before.outward.map(o => `${o.tool}:${o.kind}`);
  for (const o of after.outward) if (!had(outBefore, `${o.tool}:${o.kind}`)) out.push({ kind: "outward", what: `${o.tool} (${o.kind})` });
  for (const h of after.hosts) if (!had(before.hosts, h)) out.push({ kind: "host", what: h });
  const credBefore = before.credentials.map(c => `${c.id}:${c.provider}`);
  for (const c of after.credentials) if (!had(credBefore, `${c.id}:${c.provider}`)) out.push({ kind: "credential", what: `${c.id} (${c.provider})` });
  const connBefore = before.connections.map(c => c.provider);
  for (const c of after.connections) if (!had(connBefore, c.provider)) out.push({ kind: "connection", what: c.provider });
  const askedBefore = (before.tools.asked || []).map(t => t.tool);
  for (const t of after.tools.asked || []) if (!had(askedBefore, t.tool)) out.push({ kind: "asked", what: t.tool });
  const from = before.spend ? before.spend.dailyUsd : null, to = after.spend ? after.spend.dailyUsd : null;
  if (to !== null && (from === null || to > from)) out.push({ kind: "spend", what: `up to $${to.toFixed(2)} a day`, from, to });
  return out;
}
