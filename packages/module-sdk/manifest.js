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
import { CONTRACT, supports, moduleContract } from "./contract.js";
import { checkCapsuleShows } from "./capsule-view.js";
import { validateScreen } from "../../lib/views/blocks.js";

/** The module API majors this Vyre loads. */
export const API_VERSIONS = [1];

/** Who may call a tool (ADR 0047 section 2). anyone is the default. */
export const REACHES = ["anyone", "asked", "person", "modules", "hook"];
/** The reaches an outward tool may have: only a person or an asking agent can start one. */
const OUTWARD_REACH = ["anyone", "asked"];
/** Manifest keys only Vyre's own modules may use in 0.2, each with where it lives. */
const BUILT_IN_ONLY = [["does", "providers"], ["shows", "streams"], ["needs", "vault"], ["needs", "daemon"]];

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
 * Check a value against a schema. Returns problems as readable lines, empty when it passes. An
 * object marked "x-unknown": "warn" (the manifest's own) doesn't fail on a key it doesn't know:
 * the key goes to `warn`, since it may be a typo or a key from a newer contract minor (ADR 0047
 * section 8). Without `warn`, such keys are dropped quietly.
 * @param {any} schema @param {any} value @param {string} [where] @param {any} [root] @param {string[] | null} [warn]
 * @returns {string[]}
 */
export function checkSchema(schema, value, where = "manifest", root = schema, warn = null) {
  if (schema === true || schema === undefined) return [];
  if (schema === false) return [`${where} is not allowed`];
  if (schema.$ref) return checkSchema(resolve(root, schema.$ref), value, where, root, warn);
  const say = (/** @type {string} */ fallback) => `${where} ${schema["x-message"] || fallback}`;
  if (schema.anyOf) {
    const sinks = schema.anyOf.map(() => /** @type {string[]} */ ([]));
    const tries = schema.anyOf.map((/** @type {any} */ s, /** @type {number} */ i) => checkSchema(s, value, where, root, sinks[i]));
    const pass = tries.findIndex((/** @type {string[]} */ t) => t.length === 0);
    if (pass >= 0) { if (warn) warn.push(...sinks[pass]); return []; }
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
    if (schema.items) value.forEach((v, i) => out.push(...checkSchema(schema.items, v, `${where}[${i}]`, root, warn)));
  }
  if (TYPES.object(value)) {
    for (const k of schema.required || []) if (value[k] === undefined) out.push(`${where}.${k} is required`);
    const props = schema.properties || {};
    const patterns = Object.entries(schema.patternProperties || {}).map(([p, s]) => /** @type {[RegExp, any]} */ ([new RegExp(p), s]));
    for (const [k, v] of Object.entries(value)) {
      const at = `${where}.${k}`;
      if (schema.propertyNames) {
        const bad = checkSchema(schema.propertyNames, k, `${where} key "${k}"`, root, warn);
        if (bad.length) { out.push(...bad); continue; }
      }
      if (k in props) { out.push(...checkSchema(props[k], v, at, root, warn)); continue; }
      const matched = patterns.filter(([re]) => re.test(k));
      if (matched.length) { for (const [, s] of matched) out.push(...checkSchema(s, v, at, root, warn)); continue; }
      if (schema["x-unknown"] === "warn") { if (warn) warn.push(`${at} is not a key in module contract ${CONTRACT.current}; it is ignored (a typo, or a key from a newer contract)`); }
      else if (schema.additionalProperties === false) out.push(where.startsWith("manifest") ? `${at} is not a manifest key in module API 1` : `${at} is not allowed`);
      else if (schema.additionalProperties !== undefined) out.push(...checkSchema(schema.additionalProperties, v, at, root, warn));
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
  return checkManifestFull(m, { firstParty }).problems;
}

/**
 * checkManifest with its warnings: unknown keys and deprecated usages, which never fail a check
 * (ADR 0047 section 8). A module naming a contract this Vyre doesn't speak gets that as its one
 * problem, and nothing else is read: its keys may be from the newer contract.
 * @param {any} m
 * @param {{ firstParty?: boolean, contract?: string }} [opts] contract: the version to check against
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function checkManifestFull(m, { firstParty = false, contract } = {}) {
  /** @type {string[]} */
  const warnings = [];
  if (TYPES.object(m) && (m.vyre !== undefined || m.apiVersion !== undefined)) {
    const named = moduleContract(m, { assume: false });
    const s = supports(named, { name: typeof m.name === "string" ? m.name : "this module", ...(contract ? { contract } : {}) });
    if (!s.ok) return { problems: [s.message], warnings };
  }
  const out = checkSchema(SCHEMA, m, "manifest", SCHEMA, warnings);
  if (!TYPES.object(m) || typeof m.name !== "string") return { problems: out, warnings };
  // Deprecated: they work, and warn (ADR 0047 section 8).
  if (m.apiVersion !== undefined) warnings.push(`apiVersion is deprecated; use "vyre": "${m.apiVersion}"${m.vyre !== undefined ? " (vyre is set, so apiVersion can go)" : ""}`);
  if (TYPES.object(m.does) && m.does.senders !== undefined) warnings.push("does.senders is deprecated; mark each sending tool outward instead");
  if (TYPES.object(m.shows) && m.shows.cli !== undefined) warnings.push("shows.cli is deprecated; use does.commands");
  if (firstParty && TYPES.object(m.does) && Array.isArray(m.does.tools) && m.does.tools.some((/** @type {unknown} */ t) => typeof t === "string")) {
    warnings.push("string tool entries are deprecated; write each as { \"name\": ..., \"reach\": ... } when you next touch it");
  }
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
  // Every module, built in or added: only a person or an asking agent can start an outward tool.
  for (const t of entries) {
    if (TYPES.object(t) && typeof t.name === "string" && t.outward !== undefined && t.outward !== true && !OUTWARD_REACH.includes(t.reach || "anyone")) out.push(`tool "${t.name}": an outward tool must have reach "anyone" or "asked", not "${t.reach}"`);
  }
  // What the module adds to Flows (flow.steps, flow.triggers): each step is one of its own tools, each trigger an event it emits or a watcher it hosts. Nothing else makes a tool a Flow step.
  if (m.flow !== undefined) {
    const fl = TYPES.object(m.flow) ? m.flow : {};
    const byName = new Map(entries.filter((/** @type {any} */ t) => TYPES.object(t) && typeof t.name === "string").map((/** @type {any} */ t) => [t.name, t]));
    const seen = new Set();
    for (const st of Array.isArray(fl.steps) ? fl.steps : []) {
      if (!TYPES.object(st) || typeof st.name !== "string") continue;
      const tool = byName.get(st.name);
      if (seen.has(st.name)) out.push(`flow step "${st.name}" is declared twice`);
      seen.add(st.name);
      if (!tool) out.push(`flow step "${st.name}" is not one of this module's tools (object form)`);
      else if (st.outward === true && !tool.outward) out.push(`flow step "${st.name}" is outward, so its tool must be marked outward too`);
      else if (st.outward !== true && tool.outward) out.push(`flow step "${st.name}": an outward tool's step must say outward: true`);
      else if (tool.reach !== undefined && tool.reach !== "anyone") out.push(`flow step "${st.name}": a tool that can be a Flow step must be reach anyone`);
    }
    const emits = new Set((TYPES.object(m.watches) && Array.isArray(m.watches.emits) ? m.watches.emits : []));
    for (const tr of Array.isArray(fl.triggers) ? fl.triggers : []) {
      if (!TYPES.object(tr) || typeof tr.name !== "string") continue;
      if (!own(tr.name)) out.push(`flow trigger "${tr.name}" must start with "${m.name}."`);
      if ((tr.event === undefined) === (tr.watcher === undefined)) out.push(`flow trigger "${tr.name}" names exactly one of event or watcher`);
      else if (tr.event !== undefined && !emits.has(tr.event)) out.push(`flow trigger "${tr.name}": ${tr.event} is not an event this module emits (watches.emits)`);
    }
  }
  // An added module (ADR 0047): everything the install card shows is declared, and nothing reaches
  // past what a sandboxed host can offer in 0.2.
  if (!firstParty) {
    if (m.vyre === undefined && m.apiVersion === undefined) out.push(`"vyre" is required outside Vyre's own modules; add "vyre": "${CONTRACT.current.split(".")[0]}"`);
    if (m.description === undefined) out.push("description is required outside Vyre's own modules: one plain sentence for the install card");
    for (const t of entries) {
      if (typeof t === "string") { out.push(`tool "${t}" must be an object like { "name": "${t}", "summary": "...", "reach": "anyone" } in an added module`); continue; }
      if (!TYPES.object(t) || typeof t.name !== "string") continue;
      if (t.reach === "person") out.push(`tool "${t.name}": reach "person" is kept for Vyre's own tools; use "asked", which an agent reaches only when the person's own words asked for it`);
    }
    for (const [block, key] of BUILT_IN_ONLY) {
      const v = TYPES.object(m[block]) ? m[block][key] : undefined;
      if (Array.isArray(v) ? v.length : v !== undefined) out.push(`${block}.${key} is built in only in 0.2; an added module can't use it`);
    }
    // H3: a wildcard hides what an added module reaches; it names each tool.
    for (const t of TYPES.object(m.needs) && Array.isArray(m.needs.tools) ? m.needs.tools : []) {
      if (typeof t === "string" && t.endsWith(".*")) out.push(`needs.tools "${t}": an added module names each tool it calls; a module.* wildcard is for Vyre's own modules`);
    }
    // The setup channel's allowlist is Vyre's to grow: an added module can't put a tool on it.
    if (m.setupTools !== undefined) out.push(`setupTools is built in only; an added module can't put a tool on the setup channel`);
    // The per-call target of an asked tool is read by the registry as vyred: Vyre's own modules only.
    if (toolEntries(m).some(t => t.target)) out.push(`a tool's target is built in only; an added module can't name one`);
    // The # picker is open to an added module with three limits: its kind carries its own name (it cannot pose as Vyre's "vault" or "drive"), and its search and resolve are its own
    // read tools. What resolve may give back is cut again by the picker (no grant, no hosts, always outside text).
    if (Array.isArray(m.mentions)) {
      const entries = toolEntries(m), reads = TYPES.object(m.does) && Array.isArray(m.does.reads) ? m.does.reads : [];
      for (const e of m.mentions) {
        if (!e || typeof e !== "object") continue;
        if (typeof e.kind === "string" && e.kind !== m.name && !e.kind.startsWith(`${m.name}-`)) out.push(`mentions kind "${e.kind}": an added module's kind is its own name, or starts with "${m.name}-"`);
        for (const f of ["search", "resolve"]) {
          const t = typeof e[f] === "string" ? entries.find(x => x.name === e[f]) : null;
          if (t && !String(t.name).startsWith(`${m.name}.`)) out.push(`mentions "${e.kind}" ${f} "${t.name}" must be a tool named ${m.name}.*`);
          else if (t && !(reads.includes(t.name) || t.effect === "read")) out.push(`mentions "${e.kind}" ${f} "${t.name}" must be a read: list it under does.reads or give it effect "read"`);
        }
      }
    } else if (m.mentions !== undefined) out.push("mentions must be a list");
    // H2: in 0.2 the allowlist of modules an added module may replace is empty.
    if (m.replaces !== undefined) out.push(`replaces: an added module can't replace one of Vyre's modules; the 0.2 allowlist of replaceable modules is empty`);
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
  for (const r of Array.isArray(does.reads) ? does.reads : []) if (typeof r !== "string" || !tools.includes(r)) out.push(`does.reads names ${String(r)}, which is not under does.tools`);
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
  // setupTools names this module's own tools, so the relay never allowlists a tool that is not there.
  if (Array.isArray(m.setupTools)) {
    const own = new Set(toolEntries(m).map(t => t.name));
    for (const t of m.setupTools) if (typeof t === "string" && !own.has(t)) out.push(`setupTools "${t}" is not a tool this module declares in does.tools`);
  }
  // The Capsule's view: entries name this module's own tools (an added module's needs.tools too), and stay in the fixed vocabulary.
  if (TYPES.object(m.shows) && TYPES.object(m.shows.capsule)) {
    out.push(...checkCapsuleShows(m.shows.capsule, {
      tools: new Set(toolEntries(m).map(t => t.name)),
      needsTools: new Set(TYPES.object(m.needs) && Array.isArray(m.needs.tools) ? m.needs.tools.filter((/** @type {any} */ t) => typeof t === "string") : []),
      firstParty, moduleName: String(m.name),
    }));
  }
  // A screen in the design language (`views.<id>.screen`, or a `view:<id>` entry's): only blocks from the catalogue, props from each block's closed list, no colour, size or markup, and data
  // from the module's own tools (an added module's needs.tools too). The same check the Design MCP runs, so an agent sees the same words.
  {
    const ctx = { tools: new Set(toolEntries(m).map(t => t.name)), allowed: firstParty ? new Set() : new Set(TYPES.object(m.needs) && Array.isArray(m.needs.tools) ? m.needs.tools.filter((/** @type {any} */ t) => typeof t === "string") : []), firstParty };
    /** @type {[string, any][]} */
    const decls = [
      ...(TYPES.object(m.views) ? Object.entries(m.views).map(([id, v]) => [`views.${id}`, v]) : []),
      ...(TYPES.object(m.shows) && TYPES.object(m.shows.capsule) ? Object.entries(m.shows.capsule).filter(([k]) => k.startsWith("view:")).map(([k, v]) => [`shows.capsule "${k}"`, v]) : []),
    ];
    for (const [at, v] of decls) if (TYPES.object(v) && v.screen !== undefined) {
      if (Object.keys(v).some(k => ["list", "board", "summary", "form"].includes(k))) out.push(`${at}: a screen replaces list, board, summary and form; use blocks inside it`);
      for (const p of validateScreen(v.screen, ctx)) out.push(`${at}.screen: ${p}`);
    }
  }
  // projectArg names the input field(s) holding a project: the registry refuses an agent's call for a project it is not granted.
  for (const e of toolEntries(m)) for (const key of /** @type {const} */ (["projectArg", "cwdArg"])) {
    if (e[key] == null) continue;
    const names = Array.isArray(e[key]) ? e[key] : [e[key]];
    if (!names.length || names.some(n => typeof n !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(n))) out.push(`tool "${e.name}": ${key} must be an input field name, or a list of them`);
  }
  // crossSpace names the one kernel action another Space's authorize must allow before this tool runs there for a module (ctx.kernel.for(space).call); a tool without it is never run that way.
  for (const e of toolEntries(m)) if (e.crossSpace != null && (typeof e.crossSpace !== "string" || !/^[a-z][a-z0-9_.]{1,63}$/.test(e.crossSpace))) out.push(`tool "${e.name}": crossSpace must be a kernel action name`);
  // covers names the outward tools this tool files as part of the same act, so the person's one yes covers them (Vyre's own modules only; the registry ignores it anywhere else).
  for (const e of toolEntries(m)) if (e.covers !== undefined && (!Array.isArray(e.covers) || e.covers.length > 4 || e.covers.some((/** @type {any} */ c) => typeof c !== "string" || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(c)) || !e.outward)) out.push(`tool "${e.name}": covers is a short list of tool names, and only an outward tool has one`);
  if (!firstParty) for (const e of toolEntries(m)) if (e.covers !== undefined) out.push(`tool "${e.name}": covers is for Vyre's own modules`);
  // An asked tool's `target` names one internal tool of this module (built in only, see addedCheck).
  for (const e of toolEntries(m)) {
    if (!e.target) continue;
    const own = toolEntries(m).find(x => x.name === e.target);
    if (e.reach !== "asked") out.push(`tool "${e.name}": target is for an asked tool`);
    else if (!own || !String(e.target).startsWith(String(m.name) + ".")) out.push(`tool "${e.name}": target "${e.target}" is not a tool this module declares in does.tools`);
    else if (own.reach !== "modules") out.push(`tool "${e.name}": target "${e.target}" must be reach modules, an internal tool`);
  }
  // mentions name this module's own tools, one provider per kind.
  if (Array.isArray(m.mentions)) {
    const own = new Set(toolEntries(m).map(t => t.name));
    const kinds = new Set();
    for (const e of m.mentions) {
      if (!e || typeof e !== "object") continue;
      if (kinds.has(e.kind)) out.push(`mentions kind "${e.kind}" is declared twice`);
      kinds.add(e.kind);
      for (const f of ["search", "resolve"]) if (typeof e[f] === "string" && !own.has(e[f])) out.push(`mentions "${e.kind}" ${f} "${e[f]}" is not a tool this module declares in does.tools`);
    }
  }
  // A replacement registers the original's tools, so it carries the original's name; replaces
  // says so out loud, since a duplicate name without it is refused.
  if (typeof m.replaces === "string" && m.replaces !== m.name) out.push(`replaces is "${m.replaces}" but the module is named "${m.name}"; a replacement takes the name of the module it replaces`);
  return { problems: out, warnings };
}

// ---------------------------------------------------------------------------------------------
// What a module may do, read from its manifest alone (ADR 0047 sections 2, 4 and 6)

/**
 * The Flow steps a module declares (manifest `flow.steps`), each in one shape: the tool it runs, how a card names it, its typed fields and whether it leaves Vyre.
 * @param {any} m @returns {{ name: string, label: string, risk: "read" | "outward", inputs: Record<string, string>, outputs: Record<string, string>, recipients: string[] }[]}
 */
export function flowSteps(m) {
  const list = TYPES.object(m) && TYPES.object(m.flow) && Array.isArray(m.flow.steps) ? m.flow.steps : [];
  return list.filter((/** @type {any} */ s) => TYPES.object(s) && typeof s.name === "string").map((/** @type {any} */ s) => ({ name: s.name, label: typeof s.label === "string" ? s.label : s.name, risk: s.outward === true ? "outward" : "read", inputs: TYPES.object(s.inputs) ? { ...s.inputs } : {}, outputs: TYPES.object(s.outputs) ? { ...s.outputs } : {}, recipients: Array.isArray(s.recipients) ? s.recipients.filter((/** @type {any} */ f) => typeof f === "string") : [] }));
}

/**
 * The triggers a module declares (manifest `flow.triggers`): a named way to start a Flow that is an `event` or a `watcher` trigger underneath.
 * @param {any} m @returns {{ name: string, label: string, trigger: { on: "event", event: string } | { on: "watcher", watcher: string }, inputs: Record<string, string> }[]}
 */
export function flowTriggers(m) {
  const list = TYPES.object(m) && TYPES.object(m.flow) && Array.isArray(m.flow.triggers) ? m.flow.triggers : [];
  return list.filter((/** @type {any} */ t) => TYPES.object(t) && typeof t.name === "string" && (typeof t.event === "string") !== (typeof t.watcher === "string")).map((/** @type {any} */ t) => ({ name: t.name, label: typeof t.label === "string" ? t.label : t.name, trigger: typeof t.event === "string" ? { on: /** @type {"event"} */ ("event"), event: t.event } : { on: /** @type {"watcher"} */ ("watcher"), watcher: t.watcher }, inputs: TYPES.object(t.inputs) ? { ...t.inputs } : {} }));
}

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
    // target, projectArg and cwdArg are in the entry only when set, so the v1 shape is unchanged.
    const extra = {};
    if (typeof t.target === "string") extra.target = t.target;
    if (typeof t.projectArg === "string" || Array.isArray(t.projectArg)) extra.projectArg = t.projectArg;
    if (typeof t.cwdArg === "string" || Array.isArray(t.cwdArg)) extra.cwdArg = t.cwdArg;
    if (t.projectIsRecord === true) extra.projectIsRecord = true;
    if (t.effect === "read" || t.effect === "write") extra.effect = t.effect;
    if (t.asks === true) extra.asks = true;
    if (typeof t.crossSpace === "string") extra.crossSpace = t.crossSpace;
    if (Array.isArray(t.covers)) extra.covers = t.covers;
    // A tool a Flow's call step may run is one the module lists in flow.steps (an outward one is also `outward: true`, so it is held for a yes before it runs).
    const step = flowSteps(m).find(x => x.name === t.name);
    if (step) extra.flowStep = step;
    return [{ name: t.name, summary: typeof t.summary === "string" ? t.summary : "", reach: t.reach || "anyone", outward: t.outward || null, cost: t.cost || null, ...extra }];
  });
}

/**
 * The install card's summary, computed from the manifest: never from a module's own words about
 * itself. Outward tools are listed apart, since those are the ones that act as the person.
 * @param {any} m
 */
export function capabilities(m, { firstParty = false } = {}) {
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
  // The Capsule commands it adds, the tools those views call, and whether it wants what is in front (Part 2, step 12).
  const capsuleView = TYPES.object(shows.capsule) ? Object.entries(shows.capsule).filter(([k]) => k.startsWith("view:")) : [];
  const capsule = capsuleView.length ? {
    commands: capsuleView.map(([k, v]) => ({ id: k.slice(5), title: TYPES.object(v) && typeof v.title === "string" ? v.title : k.slice(5), root: Boolean(TYPES.object(v) && v.root) })),
    tools: [...new Set(capsuleView.flatMap(([, v]) => {
      const e = /** @type {any} */ (v), l = TYPES.object(e) && TYPES.object(e.list) ? e.list : {};
      return [l.tool, TYPES.object(l.detail) ? l.detail.tool : undefined, ...list(l.actions).map((/** @type {any} */ a) => a && a.tool),
        ...Object.values(TYPES.object(e) && TYPES.object(e.forms) ? e.forms : {}).map((/** @type {any} */ f) => f && TYPES.object(f.submit) ? f.submit.tool : undefined)].filter((/** @type {any} */ t) => typeof t === "string");
    }))],
    front: list(needs.slots).includes("front"),
  } : null;
  // What it adds to Flows (flow.steps, flow.triggers): the card says so. An added module's step is outward whatever it says (the Gate holds it for a yes); only Vyre's own modules are believed.
  const steps = flowSteps(m), triggers = flowTriggers(m);
  return {
    tools, outward,
    ...(capsule ? { capsule } : {}),
    ...(steps.length || triggers.length ? { flows: { steps: steps.map(x => ({ tool: x.name, label: x.label, outward: firstParty ? x.risk === "outward" : true })), triggers: triggers.map(x => ({ name: x.name, label: x.label })) } } : {}),
    hosts: [...list(needs.network)],
    credentials: list(needs.credentials).filter(TYPES.object).map((/** @type {any} */ c) => ({ id: c.id, kind: c.kind, provider: c.provider, purpose: c.purpose })),
    connections: list(needs.connections).filter(TYPES.object).map((/** @type {any} */ c) => ({ provider: c.provider, purpose: c.purpose })),
    spend: TYPES.object(needs.spend) && TYPES.number(needs.spend.dailyUsd) ? { dailyUsd: needs.spend.dailyUsd } : null,
    slots: [...list(shows.deck), ...list(does.commands).filter(TYPES.object).map((/** @type {any} */ c) => `command:${c.verb}`)],
    // ctx.memory.write takes a fact or a note kind declared under teaches.memory (ADR 0047 section 3).
    memory: { kinds: [...list(teaches.memory)], writes: list(teaches.memory).some((/** @type {string} */ k) => k === "fact" || k === "note") },
    notices: [...list(shows.notices)],
    // Every tool it calls through ctx.call: the card says what data each one reaches (H3).
    calls: list(needs.tools).filter((/** @type {unknown} */ t) => typeof t === "string"),
    runs: Array.isArray(m && m.roles) && m.roles.length ? [...m.roles] : ["box"],
  };
}

/**
 * What an update adds that the person hasn't granted: a new outward tool, host, credential,
 * connection or asked tool, or a higher spend cap. Empty means it installs quietly (ADR 0047
 * section 6); anything else shows the card again with only these lines.
 * @param {ReturnType<typeof capabilities>} before
 * @param {ReturnType<typeof capabilities>} after
 * @returns {{ kind: "outward" | "host" | "credential" | "connection" | "asked" | "tool" | "command" | "slot" | "spend", what: string, from?: number | null, to?: number }[]}
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
  for (const t of after.calls || []) if (!had(before.calls || [], t)) out.push({ kind: "tool", what: t });
  // A new Capsule command, or a first request for what is in front of the Capsule, needs the person's yes again.
  const cmdBefore = ((before.capsule && before.capsule.commands) || []).map(c => c.id);
  for (const c of (after.capsule && after.capsule.commands) || []) if (!had(cmdBefore, c.id)) out.push({ kind: "command", what: c.title });
  if (after.capsule && after.capsule.front && !(before.capsule && before.capsule.front)) out.push({ kind: "slot", what: "what is in front of the Capsule" });
  const from = before.spend ? before.spend.dailyUsd : null, to = after.spend ? after.spend.dailyUsd : null;
  if (to !== null && (from === null || to > from)) out.push({ kind: "spend", what: `up to $${to.toFixed(2)} a day`, from, to });
  return out;
}

/**
 * What to do with an update (ADR 0047 section 6, reviews/platform.md H1). A widening shows the card
 * with only the difference. Otherwise it installs when the person asked for this update, or gave a
 * standing "keep it updated", and waits in their list when nobody asked. codeChanged says the tree
 * differs from the pinned sha256, which the log line and the module's row name even when the
 * permissions are the same.
 * @param {{ sha256?: string, capabilities?: ReturnType<typeof capabilities>, manifest?: any }} oldLock the modules.lock.json entry
 * @param {any} newManifest
 * @param {string} newTreeSha
 * @param {{ asked?: boolean, standing?: boolean }} [o]
 * @returns {{ action: "install" | "card" | "wait", codeChanged: boolean, widened: ReturnType<typeof widened> }}
 */
export function updatePlan(oldLock, newManifest, newTreeSha, { asked = false, standing = false } = {}) {
  const before = oldLock && oldLock.capabilities ? oldLock.capabilities : capabilities(oldLock && oldLock.manifest);
  const w = widened(before, capabilities(newManifest));
  const codeChanged = !oldLock || oldLock.sha256 !== newTreeSha;
  return { action: w.length ? "card" : asked || standing ? "install" : "wait", codeChanged, widened: w };
}

export { CONTRACT, supports, parseContract, moduleContract, adapterFor } from "./contract.js";
