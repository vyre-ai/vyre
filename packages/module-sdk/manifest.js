// @ts-check
// Check a module.json against the module API (ADR 0033), with no dependencies.
//
// manifest.schema.json is the one definition of the manifest. checkSchema() is a small JSON Schema
// checker for the parts that schema uses (type, enum, pattern, properties, $ref and a few more),
// so a module author, `vyre module check` and the loader all give the same answer without pulling
// in a validator. checkManifest() adds the rules a schema can't say: a module's tools, settings,
// hooks and commands carry its own name.

import fs from "node:fs";

/** The module API majors this Vyre loads. */
export const API_VERSIONS = [1];

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
    return tries.reduce((/** @type {string[]} */ a, /** @type {string[]} */ b) => (b.length < a.length ? b : a));
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
 * Check a manifest: the schema, then the rules that need the module's name.
 * @param {any} m
 * @returns {string[]}
 */
export function checkManifest(m) {
  const out = checkSchema(SCHEMA, m);
  if (!TYPES.object(m) || typeof m.name !== "string") return out;
  const own = (/** @type {string} */ t) => t.startsWith(m.name + ".");
  const does = TYPES.object(m.does) ? m.does : {};
  const tools = Array.isArray(does.tools) ? does.tools : [];
  for (const t of tools) if (typeof t === "string" && !own(t)) out.push(`tool "${t}" must start with "${m.name}."`);
  // Everything a manifest maps to a tool must be one this module registers itself.
  /** @type {[string, any][]} */
  const mapped = [
    ...Object.entries(TYPES.object(does.hooks) ? does.hooks : {}).map(([k, t]) => /** @type {[string, any]} */ ([`does.hooks.${k}`, t])),
    ...Object.entries(TYPES.object(does.senders) ? does.senders : {}).map(([k, t]) => /** @type {[string, any]} */ ([`does.senders.${k}`, t])),
    ...(Array.isArray(does.commands) ? does.commands : []).map((c, i) => /** @type {[string, any]} */ ([`does.commands[${i}]`, c && c.tool])),
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
  }
  // A replacement registers the original's tools, so it carries the original's name; replaces
  // says so out loud, since a duplicate name without it is refused.
  if (typeof m.replaces === "string" && m.replaces !== m.name) out.push(`replaces is "${m.replaces}" but the module is named "${m.name}"; a replacement takes the name of the module it replaces`);
  return out;
}
