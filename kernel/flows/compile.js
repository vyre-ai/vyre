// @ts-check
// Compile a stored Flow against the Space's catalog before it is saved or approved (contract 9.2, "Compiled before it runs"):
// unknown types, fields, stages and actions are errors, expression names are checked, the Flow's caps must cover what its steps do,
// and an effects summary says what the Flow reads, writes, sends and runs, for the approval card and for the simulation.

import { opFor } from "./safe-write.js";
import { parseCron as parseCronShared, nextCron } from "../../lib/cron.js";
import { triggerScopeNames } from "./triggers.js";
import { expandConnections } from "./connection-step.js";
import { checkFlow, walkSteps, canonical } from "./schema.js";
import { parse, roots, stepRefs } from "./expr.js";
import { decorate } from "./places.js";
import { secretsIn } from "./no-secrets.js";
import { checkRides } from "./rides.js";
import { boundsOf, sendsOf } from "./standing.js";

/**
 * What the compiler knows about a Space.
 * @typedef {{
 *   space: string,
 *   types: Record<string, import('../contracts/fields.js').TypeDefinition>,
 *   actions: Record<string, { risk: string, label?: string }>,
 *   roles?: readonly string[],
 *   teammates?: readonly string[],
 *   pools?: readonly string[],
 *   templates?: readonly string[],
 *   connectors?: Record<string, { allow?: { method?: string, path: string }[], deny?: { method?: string, path: string }[], draft?: { method?: string, path: string },
 *     ops?: { name?: string, method: string, path: string, read?: boolean, outward?: boolean, idem?: { header?: string, param?: string }, readback?: { path: string, id: string, match: Record<string, string> } }[], rate?: { per_min: number } }>,
 * }} Catalog
 */

/** The action each record step performs, and the registry risk it is judged by. */
export const STEP_ACTIONS = Object.freeze({
  find: "records.read", pick: "records.read", create: "records.create", update: "records.update", upsert: "records.update",
  remove: "records.remove", stage: "records.update", ask: "ask.request", assign: "ask.request", agent: "ask.request",
  classify: "model.call", extract: "model.call", service: "service.call", fn: "fn.run", subflow: "flows.run",
});

const OUTWARD = new Set(["outward.send", "outward.pay", "outward.publish", "outward.delete", "outward.share"]);

/** `vyre://<space>/<type>/*` @param {string} space @param {string} type */
const typeUrn = (space, type) => `vyre://${space}/${type}/*`;

/**
 * Does a cap's resource pattern cover a needed resource? `*` stands for one whole segment, a trailing `/*` for the rest.
 * @param {string} pattern @param {string} need
 */
export function urnCovers(pattern, need) {
  const a = pattern.replace(/^vyre:\/\//, "").split("/"), b = need.replace(/^vyre:\/\//, "").split("/");
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "*" && i === a.length - 1) return true;
    if (i >= b.length) return false;
    if (a[i] !== "*" && a[i] !== b[i]) return false;
  }
  return a.length === b.length;
}

/** @param {{ action: string, resource: string }} cap @param {string} action @param {string} resource */
const capCovers = (cap, action, resource) => (cap.action === action || cap.action === "*.*") && urnCovers(cap.resource, resource);

/**
 * Every (action, resource) a Flow's steps need, in step order. Used to derive caps and to check declared ones.
 * @param {any} flow @param {Catalog} cat @returns {{ step: string, path: string, action: string, resource: string }[]}
 */
export function needs(flow, cat) {
  /** @type {{ step: string, path: string, action: string, resource: string }[]} */
  const out = [];
  const each = (/** @type {any} */ s, /** @type {string} */ path) => {
    if (s.kind === "call") { if (typeof s.action === "string" && typeof s.resource === "string") out.push({ step: s.id, path, action: s.action, resource: s.resource }); return; }
    const action = /** @type {Record<string, string>} */ (STEP_ACTIONS)[s.kind];
    if (!action) return;
    if (["find", "pick", "create", "update", "upsert", "remove", "stage"].includes(s.kind)) out.push({ step: s.id, path, action, resource: typeUrn(cat.space, String(s.type)) });
    else if (s.kind === "service") out.push({ step: s.id, path, action: serviceActionOf(cat, s), resource: serviceResource(cat.space, s.connector) });
    else if (s.kind === "subflow") out.push({ step: s.id, path, action, resource: `vyre://${cat.space}/flow/*` });
    else out.push({ step: s.id, path, action, resource: `vyre://${cat.space}/${action === "ask.request" ? "task" : action.split(".")[0]}/*` });
    if (s.kind === "upsert") out.push({ step: s.id, path, action: "records.create", resource: typeUrn(cat.space, String(s.type)) });
  };
  walkSteps(flow.steps || [], each);
  walkSteps(flow.on_failure || [], each, "on_failure");
  return out;
}

/** A read (GET or HEAD) is `service.read`; anything else sends, posts, pays or changes, and is `service.call`, an outward act the vault holds for the ask-first task. @param {string} method */
export const serviceAction = method => (method === "GET" || method === "HEAD" ? "service.read" : "service.call");
/**
 * The action a service step is judged by. When the connector declares operations (records/connectors), the matching operation's own `outward` flag decides: outward is `service.call` (held for a
 * yes), anything else `service.read`, so a draft operation that writes is not outward. A connector with no declaration keeps the method rule.
 * @param {any} cat @param {any} s
 */
export function serviceActionOf(cat, s) {
  const conn = cat && cat.connectors && cat.connectors[s.connector];
  const op = conn && conn.ops ? opFor(conn, String(s.method || "GET").toUpperCase(), String(s.path || "")) : null;
  return op ? (op.outward ? "service.call" : "service.read") : serviceAction(s.method);
}
/** `vyre://<space>/service/<connector>` @param {string} space @param {string} connector */
export const serviceResource = (space, connector) => `vyre://${space}/service/${connector}`;

/** Does `pattern` match `s`? `*` stands for one whole path segment, a trailing `/*` for the rest. @param {string} pattern @param {string} s */
function pathMatches(pattern, s) {
  const a = pattern.split("/"), b = s.split("/");
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "*" && i === a.length - 1) return b.length > i;
    if (i >= b.length) return false;
    if (a[i] !== "*" && a[i] !== b[i]) return false;
  }
  return a.length === b.length;
}
/**
 * The vault route's rule, mirrored for the compiler (the vault checks again at the call): deny wins, the default is no. A rule is { method?, path }.
 * @param {{ allow?: { method?: string, path: string }[], deny?: { method?: string, path: string }[] }} route @param {string} method @param {string} path
 */
export function routeAllows(route, method, path) {
  const hit = (/** @type {{ method?: string, path: string }} */ r) => (!r.method || r.method === "*" || r.method.toUpperCase() === method) && pathMatches(r.path, path);
  if ((route.deny || []).some(hit)) return false;
  return (route.allow || []).some(hit);
}

/** The narrowest caps that let the Flow's steps run: one per distinct (action, resource). @param {any} flow @param {Catalog} cat */
export function deriveCaps(flow, cat) {
  const seen = new Set();
  const caps = [];
  for (const n of needs(flow, cat)) {
    const k = n.action + " " + n.resource;
    if (!seen.has(k)) { seen.add(k); caps.push({ action: n.action, resource: n.resource }); }
  }
  return caps;
}

/**
 * @param {any} flow a stored Flow
 * @param {Catalog} cat
 * @returns {{ ok: boolean, errors: { path: string, message: string, step?: string, fix?: string }[], warnings: { path: string, message: string }[], effects: Effects, caps: { action: string, resource: string }[] }}
 */
export function compileFlow(flow, cat) {
  const r = compileRaw(flow, cat);
  return { ...r, errors: decorate(flow, r.errors), warnings: r.warnings };
}

/** @param {any} flow @param {Catalog} cat @returns {ReturnType<typeof compileFlow>} */
function compileRaw(flow, cat) {
  /** @type {any[]} */ const errors = checkFlow(flow);
  for (const x of secretsIn(flow)) errors.push({ path: x.path, message: `this looks like ${x.kind}: a Flow never holds a key, a password or a token. Put it in the Vault and name the Connection instead (the Vault uses it; the Flow only names it)` });
  // A "Call a service" step that names a Connection is written out as the service step it stands for before anything reads it; what is stored is the written-out Flow (connection-step.js).
  if (!errors.length) {
    const ex = expandConnections(flow, cat);
    if (ex.errors.length) return { ok: false, errors: ex.errors, warnings: [], effects: { reads: [], writes: [], outward: [], services: [], code: [], asks: 0, assigns: [], sealed_uses: [], destinations: [], model_steps: [], needs_run_ask: false }, caps: [] };
    flow = ex.flow;
  }
  /** @type {{ path: string, message: string }[]} */
  const warnings = [];
  /** @type {Effects} */
  const effects = { reads: [], writes: [], outward: [], services: [], code: [], asks: 0, assigns: [], sealed_uses: [], destinations: [], model_steps: [], needs_run_ask: false };
  if (errors.length) return { ok: false, errors, warnings, effects, caps: [] };

  const type = (/** @type {string} */ name, /** @type {string} */ path) => {
    const t = cat.types[name];
    if (!t) errors.push({ path, message: `there is no record type ${name}`, bad: name, choices: Object.keys(cat.types) });
    return t;
  };
  const fieldNames = (/** @type {any} */ t) => new Set((t.fields || []).map((/** @type {any} */ f) => f.name));
  const sealedNames = new Set(Object.values(cat.types).flatMap(t => (t.fields || []).filter(f => f.kind === "sealed").map(f => f.name)));

  // Trigger
  const tr = flow.trigger;
  if (tr.on === "stage") {
    const t = type(tr.type, "trigger.type");
    if (t && !(t.stages || []).some(st => st.name === tr.stage)) errors.push({ path: "trigger.stage", message: `${tr.type} has no stage ${tr.stage}`, bad: tr.stage, choices: (t.stages || []).map(st => st.name) });
  }
  if (tr.on === "time" && tr.cron !== undefined) { const c = parseCron(tr.cron); if (!c.ok) errors.push({ path: "trigger.cron", message: c.message }); }

  /** scope names an expression may read at a given point */
  const triggerScope = triggerScopeNames(tr);
  const baseScope = new Set([...triggerScope, "steps", "run", "now"]);

  /** @param {string|undefined} src @param {string} path @param {Set<string>} scope @param {Set<string>} done */
  function checkExprNames(src, path, scope, done) {
    if (typeof src !== "string") return;
    let ast;
    try { ast = parse(src); } catch { return; }
    for (const r of roots(ast)) if (!scope.has(r)) errors.push({ path, message: `${r} is not available here (a Flow's expressions read ${[...scope].join(", ")})`, bad: r, choices: [...scope] });
    for (const ref of stepRefs(ast)) if (!done.has(ref)) errors.push({ path, message: `steps.${ref} is not a step that has already run`, bad: ref, choices: [...done] });
    if (sealedNames.size) for (const r of src.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) if (sealedNames.has(r)) { effects.sealed_uses.push({ path, field: r }); }
  }
  /** @param {any} v @param {string} path @param {Set<string>} scope @param {Set<string>} done */
  function checkValueNames(v, path, scope, done) {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach((x, i) => checkValueNames(x, `${path}[${i}]`, scope, done)); return; }
    if (Object.hasOwn(v, "expr")) { checkExprNames(v.expr, path, scope, done); return; }
    for (const k of Object.keys(v)) checkValueNames(v[k], `${path}.${k}`, scope, done);
  }
  /** a value that is a constant (no expr anywhere) @param {any} v @returns {boolean} */
  const isConst = v => v === null || typeof v !== "object" ? true : Array.isArray(v) ? v.every(isConst) : Object.hasOwn(v, "expr") ? false : Object.values(v).every(isConst);

  /** @param {any[]} steps @param {string} base @param {Set<string>} scope @param {Set<string>} done */
  function visit(steps, base, scope, done) {
    steps.forEach((s, i) => {
      const p = `${base}[${i}]`;
      const t = s.type ? type(s.type, `${p}.type`) : undefined;
      if (["create", "update", "upsert"].includes(s.kind) && t) {
        const names = fieldNames(t);
        for (const k of Object.keys(s.set || {})) if (!names.has(k)) errors.push({ path: `${p}.set.${k}`, message: `${s.type} has no field ${k}`, bad: k, choices: [...names] });
        if (s.kind === "upsert") for (const k of Object.keys(s.match || {})) if (!names.has(k)) errors.push({ path: `${p}.match.${k}`, message: `${s.type} has no field ${k}`, bad: k, choices: [...names] });
        for (const k of Object.keys(s.set || {})) if ((t.fields || []).find(f => f.name === k)?.kind === "sealed") errors.push({ path: `${p}.set.${k}`, message: `${k} is sealed: a Flow cannot write a sealed value (it is entered by a person, or by an Ask)` });
      }
      if (s.kind === "stage" && t && s.to && !(t.stages || []).some(st => st.name === s.to)) errors.push({ path: `${p}.to`, message: `${s.type} has no stage ${s.to}`, bad: s.to, choices: (t.stages || []).map(st => st.name) });
      if (s.kind === "call") {
        const a = cat.actions[s.action];
        if (!a) errors.push({ path: `${p}.action`, message: `there is no action ${s.action}`, bad: s.action, choices: Object.keys(cat.actions) });
        else if (OUTWARD.has(a.risk)) effects.outward.push({ step: s.id, action: s.action, risk: a.risk, destination_constant: isConst(s.input) });
      }
      if (["assign", "agent"].includes(s.kind)) {
        const who = String(s.kind === "agent" ? s.assistant : s.to);
        const [kind, name] = [who.split(":")[0], who.slice(who.indexOf(":") + 1)];
        if (kind === "teammate" && cat.teammates && !cat.teammates.includes(name)) errors.push({ path: `${p}.${s.kind === "agent" ? "assistant" : "to"}`, message: `there is no teammate ${name}`, bad: name, choices: cat.teammates });
        if (kind === "pool" && cat.pools && !cat.pools.includes(name)) errors.push({ path: `${p}.${s.kind === "agent" ? "assistant" : "to"}`, message: `there is no pool ${name}`, bad: name, choices: cat.pools });
        if (kind === "role" && cat.roles && !cat.roles.includes(name)) errors.push({ path: `${p}.to`, message: `there is no role ${name}`, bad: name, choices: cat.roles });
        if (s.template && cat.templates && !cat.templates.includes(String(s.template))) errors.push({ path: `${p}.template`, message: `there is no template ${s.template}`, bad: String(s.template), choices: cat.templates });
        effects.assigns.push({ step: s.id, to: who, checker: s.checker || null, output: s.output && s.output.kind });
      }
      if (s.kind === "ask") effects.asks++;
      if (s.kind === "service") {
        const route = cat.connectors && cat.connectors[s.connector];
        const read = serviceActionOf(cat, s) === "service.read";
        if (!route) errors.push({ path: `${p}.connector`, message: `there is no connector ${s.connector}: a firm adds the credential and its route first`, bad: s.connector, choices: Object.keys(cat.connectors || {}) });
        else if (!routeAllows(route, s.method, s.path)) errors.push({ path: `${p}.path`, message: `the ${s.connector} connector does not allow ${s.method} ${s.path}` });
        const files = s.drive ? [...(s.drive.upload ? [{ way: "send", path: s.drive.upload.path, version: s.drive.upload.version ?? null }] : []), ...(s.drive.saveTo ? [{ way: "save", path: s.drive.saveTo, version: null }] : [])] : [];
        effects.services.push({ step: s.id, connector: s.connector, method: s.method, path: s.path, outward: !read, files });
        // A read runs at once; anything else is held for the ask-first task, so the approval card lists the connector, the method, the path and the Drive files.
        if (!read) effects.outward.push({ step: s.id, action: "service.call", risk: "outward.send", destination_constant: true });
      }
      if (s.kind === "fn") effects.code.push({ step: s.id, hash: s.hash || null, needs: s.needs || [], outputs: s.outputs });
      if (s.kind === "classify" || s.kind === "extract" || s.kind === "agent") effects.model_steps.push(s.id);
      if (s.kind === "find" || s.kind === "pick") { if (t && !effects.reads.includes(s.type)) effects.reads.push(s.type); }
      if (["create", "update", "upsert", "remove", "stage"].includes(s.kind) && !effects.writes.includes(s.type)) effects.writes.push(s.type);

      // names inside expressions and values
      const nm = (/** @type {any} */ v, /** @type {string} */ k) => checkValueNames(v, `${p}.${k}`, scope, done);
      const ex = (/** @type {any} */ v, /** @type {string} */ k) => checkExprNames(v, `${p}.${k}`, scope, done);
      switch (s.kind) {
        case "find": case "pick": checkExprNames(s.where, `${p}.where`, new Set([...scope, "record"]), done); break;
        case "filter": ex(s.from, "from"); checkExprNames(s.where, `${p}.where`, new Set([...scope, "record"]), done); break;
        case "create": nm(s.set, "set"); break;
        case "update": nm(s.record, "record"); nm(s.set, "set"); break;
        case "upsert": nm(s.match, "match"); nm(s.set, "set"); break;
        case "remove": nm(s.record, "record"); break;
        case "stage": nm(s.record, "record"); break;
        case "wait": if (s.until !== undefined) nm(s.until, "until"); checkExprNames(s.where, `${p}.where`, new Set([...scope, "event"]), done); break;
        case "ask": nm(s.title, "title"); break;
        case "assign": nm(s.title, "title"); nm(s.record, "record"); break;
        case "agent": nm(s.title, "title"); nm(s.instructions, "instructions"); nm(s.record, "record"); break;
        case "call": nm(s.input, "input"); break;
        case "classify": nm(s.input, "input"); break;
        case "extract": nm(s.input, "input"); break;
        case "service": nm(s.query, "query"); nm(s.headers, "headers"); nm(s.body, "body"); if (s.body !== undefined && !isConst(s.body) && serviceActionOf(cat, s) === "service.call") effects.destinations.push({ step: s.id, note: "the body is read from records" }); break;
        case "fn": nm(s.inputs, "inputs"); break;
        default: break;
      }
      if (s.kind === "decide") {
        ex(s.if, "if");
        visit(s.then || [], `${p}.then`, scope, new Set(done));
        if (s.else) visit(s.else, `${p}.else`, scope, new Set(done));
      } else if (s.kind === "repeat") {
        ex(s.over, "over");
        visit(s.steps || [], `${p}.steps`, new Set([...scope, s.as]), new Set(done));
      } else if (s.kind === "parallel") {
        // lanes run at the same time: a lane reads what ran before the parallel step, never what a sibling lane makes; after it, every lane's steps have run
        const after = new Set(done);
        for (const [j, lane] of (s.steps || []).entries()) {
          const inLane = new Set(done);
          visit(lane.steps || [], `${p}.steps[${j}].steps`, scope, inLane);
          for (const id of inLane) after.add(id);
          after.add(lane.id);
        }
        for (const id of after) done.add(id);
      } else if (s.kind === "subflow") nm(s.input, "input");
      // the failure path reads the error that sent it there; a VERIFY reads the step's own output (R031 Flows reliability)
      if (s.on_fail && Array.isArray(s.on_fail.steps)) visit(s.on_fail.steps, `${p}.on_fail.steps`, new Set([...scope, "error"]), new Set(done));
      if (s.verify && typeof s.verify.check === "string") checkExprNames(s.verify.check, `${p}.verify.check`, new Set([...scope, "output"]), done);
      done.add(s.id);
    });
  }
  visit(flow.steps, "steps", baseScope, new Set());
  checkRides(flow.steps, cat, errors);
  { const sends = sendsOf(flow, cat); if (sends.length) /** @type {any} */ (effects).sends = { steps: sends, ...boundsOf(flow, cat) }; }
  walkSteps(flow.steps, (/** @type {any} */ st) => { if (st.kind === "call" && st.with !== undefined) { const o = effects.outward.find((/** @type {any} */ x) => x.step === st.id); if (o) o.with = st.with; } });
  // Flow-level failure path: any step may have run before it, and it reads the error
  if (Array.isArray(flow.on_failure)) { /** @type {Set<string>} */ const all = new Set(); walkSteps(flow.steps, (x) => all.add(x.id)); visit(flow.on_failure, "on_failure", new Set([...baseScope, "error"]), all); }
  if (flow.returns !== undefined) { /** @type {Set<string>} */ const all = new Set(); walkSteps(flow.steps, (x) => all.add(x.id)); checkValueNames(flow.returns, "returns", new Set(baseScope), all); }
  if (typeof flow.lock === "string") checkExprNames(flow.lock, "lock", new Set(triggerScope), new Set());
  if ((tr.on === "event" || tr.on === "watcher") && tr.where) checkExprNames(tr.where, "trigger.where", new Set(triggerScope), new Set());

  // caps
  const derived = deriveCaps(flow, cat);
  const caps = Array.isArray(flow.caps) ? flow.caps : derived;
  if (Array.isArray(flow.caps)) {
    for (const n of needs(flow, cat)) if (!caps.some((/** @type {any} */ c) => capCovers(c, n.action, n.resource))) errors.push({ path: n.path, message: `the Flow's caps do not cover ${n.action} on ${n.resource}` });
    for (const c of caps) if (c.action !== "*.*" && !cat.actions[c.action] && !/^(?:records|ask|model|service|fn|flows)\./.test(c.action)) warnings.push({ path: "caps", message: `the cap names an unknown action ${c.action}` });
  } else if (derived.length) warnings.push({ path: "caps", message: "no caps are declared, so the Flow's own steps set them" });

  if (flow.authorship === "model" && (effects.sealed_uses.length || effects.outward.some(o => !o.destination_constant))) {
    effects.needs_run_ask = true;
    warnings.push({ path: "", message: "drafted by a model: a sealed value or a destination read from records needs a person's Ask on every run" });
  }
  // A Flow a model wrote checks what its steps did: an effect step with no VERIFY is named, so the author (@Engineer) adds one before proposing it.
  if (flow.authorship === "model") walkSteps(flow.steps, (x, path) => { if (["create", "update", "upsert", "remove", "stage"].includes(x.kind) && !x.verify) warnings.push({ path, message: `step ${x.id} changes a record and checks nothing: add a verify (for example verify: { readback: true }) so a write that did not take is a failure, not a success` }); });
  if (flow.authorship === "kit") warnings.push({ path: "", message: "from a Kit: its text counts as external until a person has reviewed it" });
  return { ok: errors.length === 0, errors, warnings, effects, caps, flow };
}

/**
 * @typedef {{
 *   reads: string[], writes: string[],
 *   outward: { step: string, action: string, risk: string, destination_constant: boolean, with?: string }[],
 *   services: { step: string, connector: string, method: string, path: string, outward: boolean, files: { way: string, path: string, version: string|null }[] }[],
 *   code: { step: string, hash: string|null, needs: string[], outputs: string[] }[],
 *   asks: number, assigns: { step: string, to: string, checker: string|null, output: string }[],
 *   sealed_uses: { path: string, field: string }[], destinations: { step: string, note: string }[],
 *   model_steps: string[], needs_run_ask: boolean,
 * }} Effects
 */

// ---- cron: lib/cron.js, shared with the watchers ----

/** @param {string} src @returns {{ ok: true, sets: Set<number>[], domStar: boolean, dowStar: boolean, text: string } | { ok: false, message: string }} */
export const parseCron = src => parseCronShared(src);
export { nextCron };

export { canonical };
