// @ts-check
// The stored form of a Flow (contract 5.6, 9.1): structured data, the source of truth. The TypeScript text form (text.js) is a
// projection of this and nothing more. This file says what a stored Flow is, checks its shape, and makes its canonical form
// and hash (the hash is what an approval binds to: two texts that store identically are one approval, 9.2).

import crypto from "node:crypto";
import { parse, ExprError } from "./expr.js";
import { TRIGGER_ONS, checkTrigger as checkTriggerKind } from "./triggers.js";

export const FLOW_FORMAT = 1;

export const STEP_KINDS = Object.freeze(["find", "pick", "filter", "create", "update", "upsert", "remove", "decide", "repeat", "wait", "ask", "assign", "call", "stage", "agent", "classify", "service", "fn"]);
/** Steps that hold a nested list of steps. */
export const BLOCK_KINDS = Object.freeze({ decide: ["then", "else"], repeat: ["steps"] });
export const TRIGGER_KINDS = TRIGGER_ONS;
export const AUTHORSHIP = Object.freeze(["builder", "human", "model", "kit"]);
export const LIMITS = Object.freeze({ steps: 200, depth: 6, name: 120, codeSource: 64 * 1024, repeatMax: 1000 });

const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/; // record type names are the kernel's: lowercase letters, digits and hyphens (fields and roles keep underscores)
const ACTION_RE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const EVENT_RE = /^[a-z][a-z0-9_-]*\.(?:[a-z][a-z0-9_-]*|\*)$/;
const URN_RE = /^vyre:\/\/[^/\s]+\/[^\s]*$/;

/** @typedef {{ path: string, message: string }} Problem */

const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A value inside a step: a literal, or `{ expr: "..." }` to read the run's scope. Never an action name or a resource (those are literal).
 * @param {any} v @param {string} path @param {Problem[]} out
 */
export function checkValue(v, path, out) {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return;
  if (Array.isArray(v)) { v.forEach((x, i) => checkValue(x, `${path}[${i}]`, out)); return; }
  if (isObj(v)) {
    if (Object.hasOwn(v, "expr")) {
      if (Object.keys(v).length !== 1 || typeof v.expr !== "string") out.push({ path, message: "an expression value is exactly { expr: \"...\" }" });
      else try { parse(v.expr); } catch (e) { out.push({ path, message: `the expression does not parse: ${e instanceof ExprError ? e.message : String(e)}` }); }
      return;
    }
    for (const k of Object.keys(v)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") { out.push({ path: `${path}.${k}`, message: `${k} is not a name a definition may use` }); continue; }
      checkValue(v[k], `${path}.${k}`, out);
    }
    return;
  }
  out.push({ path, message: "a value is a string, number, boolean, null, a list, an object or { expr }" });
}

/** @param {any} v @param {string} path @param {Problem[]} out */
function checkExpr(v, path, out) {
  if (typeof v !== "string") { out.push({ path, message: "an expression is a string" }); return; }
  try { parse(v); } catch (e) { out.push({ path, message: `the expression does not parse: ${e instanceof ExprError ? e.message : String(e)}` }); }
}

/** @param {any} o @param {string[]} allowed @param {string} path @param {Problem[]} out */
function onlyKeys(o, allowed, path, out) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push({ path: `${path}.${k}`, message: `${k} is not part of this` });
}

/** @param {any} t @param {Problem[]} out */
function checkTrigger(t, out) { checkTriggerKind(t, out, { onlyKeys, checkExpr, EVENT_RE, NAME_RE }); }

/** Keys each step kind may carry (beyond id, kind, label). */
const STEP_KEYS = {
  find: ["type", "where", "limit", "sort"], pick: ["type", "where"], filter: ["from", "where"],
  create: ["type", "set"], update: ["type", "record", "set"], upsert: ["type", "match", "set"], remove: ["type", "record"],
  decide: ["if", "then", "else"], repeat: ["over", "as", "steps", "max"],
  wait: ["for_ms", "until", "event", "where", "timeout_ms", "on_timeout"],
  ask: ["to", "title", "form", "record"], assign: ["to", "title", "record", "output", "how", "template", "checker", "await", "skills"],
  call: ["action", "resource", "input"], stage: ["type", "record", "to"],
  agent: ["assistant", "title", "instructions", "record", "output", "await", "skills"], classify: ["input", "labels"],
  service: ["connector", "method", "path", "query", "headers", "body", "drive"],
  fn: ["language", "source", "hash", "inputs", "outputs", "needs"],
};

const OUTPUT_KINDS = ["fields", "note", "draft", "sent", "decision", "file"];

/**
 * @param {any} steps @param {string} path @param {Problem[]} out @param {Set<string>} ids @param {number} depth
 * @param {{ count: number }} budget
 */
function checkSteps(steps, path, out, ids, depth, budget) {
  if (!Array.isArray(steps)) { out.push({ path, message: "steps are a list" }); return; }
  if (depth > LIMITS.depth) { out.push({ path, message: `steps nest at most ${LIMITS.depth} deep` }); return; }
  steps.forEach((s, i) => {
    const p = `${path}[${i}]`;
    if (++budget.count > LIMITS.steps) { if (budget.count === LIMITS.steps + 1) out.push({ path, message: `a Flow has at most ${LIMITS.steps} steps` }); return; }
    if (!isObj(s)) { out.push({ path: p, message: "a step is an object" }); return; }
    if (typeof s.id !== "string" || !ID_RE.test(s.id)) out.push({ path: `${p}.id`, message: "a step id is lowercase letters, digits and underscores, starting with a letter" });
    else if (ids.has(s.id)) out.push({ path: `${p}.id`, message: `the step id ${s.id} is used twice` });
    else ids.add(s.id);
    if (!STEP_KINDS.includes(s.kind)) { out.push({ path: `${p}.kind`, message: `a step is one of ${STEP_KINDS.join(", ")}` }); return; }
    const keys = STEP_KEYS[/** @type {keyof typeof STEP_KEYS} */ (s.kind)];
    onlyKeys(s, ["id", "kind", "label", ...keys], p, out);
    if (s.label !== undefined && (typeof s.label !== "string" || s.label.length > LIMITS.name)) out.push({ path: `${p}.label`, message: "a label is a short string" });
    const need = (/** @type {string} */ k, /** @type {(v: any) => boolean} */ ok, /** @type {string} */ msg) => { if (s[k] === undefined || !ok(s[k])) out.push({ path: `${p}.${k}`, message: msg }); };
    const typeName = (/** @type {any} */ v) => typeof v === "string" && NAME_RE.test(v);
    const exprOk = (/** @type {string} */ k) => { if (s[k] !== undefined) checkExpr(s[k], `${p}.${k}`, out); };
    const value = (/** @type {string} */ k) => { if (s[k] !== undefined) checkValue(s[k], `${p}.${k}`, out); };
    switch (s.kind) {
      case "find": need("type", typeName, "name the record type"); exprOk("where"); if (s.limit !== undefined && !(Number.isInteger(s.limit) && s.limit >= 1 && s.limit <= 1000)) out.push({ path: `${p}.limit`, message: "limit is 1 to 1000" }); break;
      case "pick": need("type", typeName, "name the record type"); exprOk("where"); break;
      case "filter": need("from", v => typeof v === "string", "name the list (an expression)"); exprOk("from"); need("where", v => typeof v === "string", "give the condition"); exprOk("where"); break;
      case "create": need("type", typeName, "name the record type"); need("set", isObj, "set the fields"); value("set"); break;
      case "update": need("type", typeName, "name the record type"); need("record", () => true, "name the record"); value("record"); need("set", isObj, "set the fields"); value("set"); break;
      case "upsert": need("type", typeName, "name the record type"); need("match", isObj, "say how to find an existing record"); value("match"); need("set", isObj, "set the fields"); value("set"); break;
      case "remove": need("type", typeName, "name the record type"); need("record", () => true, "name the record"); value("record"); break;
      case "decide":
        need("if", v => typeof v === "string", "give the condition"); exprOk("if");
        for (const b of ["then", "else"]) if (s[b] !== undefined) checkSteps(s[b], `${p}.${b}`, out, ids, depth + 1, budget);
        if (s.then === undefined) out.push({ path: `${p}.then`, message: "give the steps to run when it holds" });
        break;
      case "repeat":
        need("over", v => typeof v === "string", "name the list (an expression)"); exprOk("over");
        need("as", v => typeof v === "string" && ID_RE.test(v), "name the item");
        if (s.max !== undefined && !(Number.isInteger(s.max) && s.max >= 1 && s.max <= LIMITS.repeatMax)) out.push({ path: `${p}.max`, message: `max is 1 to ${LIMITS.repeatMax}` });
        checkSteps(s.steps, `${p}.steps`, out, ids, depth + 1, budget);
        break;
      case "wait": {
        const given = ["for_ms", "until", "event"].filter(k => s[k] !== undefined);
        if (given.length !== 1) out.push({ path: p, message: "a wait has exactly one of for_ms, until or event" });
        if (s.for_ms !== undefined && !(Number.isInteger(s.for_ms) && s.for_ms >= 0)) out.push({ path: `${p}.for_ms`, message: "for_ms is a whole number of milliseconds" });
        if (s.until !== undefined) value("until");
        if (s.event !== undefined && (typeof s.event !== "string" || !EVENT_RE.test(s.event))) out.push({ path: `${p}.event`, message: "an event pattern is noun.past-verb or noun.*" });
        exprOk("where");
        if (s.event !== undefined && s.timeout_ms === undefined) out.push({ path: `${p}.timeout_ms`, message: "waiting for an event needs a timeout" });
        if (s.timeout_ms !== undefined && !(Number.isInteger(s.timeout_ms) && s.timeout_ms > 0)) out.push({ path: `${p}.timeout_ms`, message: "timeout_ms is a whole number of milliseconds" });
        if (s.on_timeout !== undefined && !["continue", "fail"].includes(s.on_timeout)) out.push({ path: `${p}.on_timeout`, message: "on_timeout is continue or fail" });
        break;
      }
      case "ask":
        need("to", v => typeof v === "string" && /^(?:person|role):/.test(v), "ask a person or a role: person:<id> or role:<name>");
        need("title", () => true, "give the question"); value("title");
        if (s.form !== undefined) { if (!Array.isArray(s.form) || !s.form.every((f/** @type {any} */) => isObj(f) && typeof f.name === "string")) out.push({ path: `${p}.form`, message: "a form is a list of fields with names" }); }
        break;
      case "assign":
        need("to", v => typeof v === "string" && /^(?:person|teammate|role|pool):/.test(v), "assign to person:<id>, teammate:<name>, role:<name> or pool:<name>");
        if (s.skills !== undefined && !(Array.isArray(s.skills) && s.skills.length <= 20 && s.skills.every((/** @type {any} */ x) => typeof x === "string" && x.length > 0 && x.length <= 60))) out.push({ path: `${p}.skills`, message: "skills is a short list of words" });
        need("title", () => true, "give the title"); value("title");
        checkOutput(s.output, `${p}.output`, out);
        if (s.how !== undefined && !["template", "tailor", "assistant", "person"].includes(s.how)) out.push({ path: `${p}.how`, message: "how is template, tailor, assistant or person" });
        if (s.checker !== undefined && (typeof s.checker !== "string" || !/^(?:person|role):/.test(s.checker))) out.push({ path: `${p}.checker`, message: "a checker is person:<id> or role:<name>" });
        value("record");
        break;
      case "agent":
        need("assistant", v => typeof v === "string" && /^(?:teammate|pool):/.test(v), "name the assistant: teammate:<name> or pool:<name>");
        if (s.skills !== undefined && !(Array.isArray(s.skills) && s.skills.length <= 20 && s.skills.every((/** @type {any} */ x) => typeof x === "string" && x.length > 0 && x.length <= 60))) out.push({ path: `${p}.skills`, message: "skills is a short list of words" });
        need("title", () => true, "give the title"); value("title"); need("instructions", () => true, "say what to do"); value("instructions");
        checkOutput(s.output, `${p}.output`, out); value("record");
        break;
      case "call":
        need("action", v => typeof v === "string" && ACTION_RE.test(v), "an action is module.verb, written out (never read from a value)");
        need("resource", v => typeof v === "string" && URN_RE.test(v), "a resource is a vyre:// address, written out (never read from a value)");
        if (s.input !== undefined) checkValue(s.input, `${p}.input`, out);
        break;
      case "stage": need("type", typeName, "name the record type"); need("record", () => true, "name the record"); value("record"); need("to", v => typeof v === "string" && v.length > 0, "name the stage"); break;
      case "classify": need("input", () => true, "give the text to classify"); value("input"); need("labels", v => Array.isArray(v) && v.length >= 2 && v.every((x/** @type {any} */) => typeof x === "string"), "give at least two labels"); break;
      case "service":
        // The Flow names a connector (a vault credential and its route), never a web address or a credential: the home's vault holds the host and the key.
        need("connector", v => typeof v === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(v), "name the connector (lowercase letters, digits, - and _)");
        need("method", v => ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(v), "method is GET, HEAD, POST, PUT, PATCH or DELETE");
        need("path", v => typeof v === "string" && /^\/[^\s?#]*$/.test(v) && !v.split("/").includes(".."), "the path starts with / and is written out (the query goes in `query`)");
        if (s.query !== undefined) { if (!isObj(s.query)) out.push({ path: `${p}.query`, message: "the query is an object of names and values" }); else checkValue(s.query, `${p}.query`, out); }
        value("headers"); value("body");
        if (s.headers !== undefined && isObj(s.headers)) for (const h of Object.keys(s.headers)) if (/^(authorization|proxy-authorization|cookie|x-api-key|host)$/i.test(h)) out.push({ path: `${p}.headers.${h}`, message: `${h} is the vault's: a Flow never sets it` });
        if (s.drive !== undefined) {
          if (!isObj(s.drive)) out.push({ path: `${p}.drive`, message: "drive is { upload?, saveTo? }" });
          else {
            onlyKeys(s.drive, ["upload", "saveTo"], `${p}.drive`, out);
            if (s.drive.upload !== undefined) {
              if (!isObj(s.drive.upload) || typeof s.drive.upload.path !== "string" || !s.drive.upload.path || String(s.drive.upload.path).split("/").includes("..")) out.push({ path: `${p}.drive.upload`, message: "an upload names a Drive path: { path, version?, contentType? }" });
              else onlyKeys(s.drive.upload, ["path", "version", "contentType"], `${p}.drive.upload`, out);
            }
            if (s.drive.saveTo !== undefined && (typeof s.drive.saveTo !== "string" || !s.drive.saveTo || s.drive.saveTo.split("/").includes(".."))) out.push({ path: `${p}.drive.saveTo`, message: "saveTo is a Drive path" });
            if (s.drive.upload !== undefined && s.drive.saveTo !== undefined) out.push({ path: `${p}.drive`, message: "a step sends a file or saves one, not both" });
          }
        }
        break;
      case "fn":
        need("language", v => v === "js", "the language is js");
        need("source", v => typeof v === "string" && v.length <= LIMITS.codeSource, `the source is text, at most ${LIMITS.codeSource} characters`);
        need("inputs", isObj, "name the inputs"); value("inputs");
        need("outputs", v => Array.isArray(v) && v.every((x/** @type {any} */) => typeof x === "string" && ID_RE.test(x)), "name the outputs");
        if (s.needs !== undefined && !(Array.isArray(s.needs) && s.needs.every((x/** @type {any} */) => typeof x === "string"))) out.push({ path: `${p}.needs`, message: "needs is a list of declared powers" });
        if (typeof s.source === "string" && s.hash !== undefined && s.hash !== sourceHash(s.source)) out.push({ path: `${p}.hash`, message: "the hash does not match the source" });
        break;
      default: break;
    }
  });
}

/** @param {any} o @param {string} path @param {Problem[]} out */
function checkOutput(o, path, out) {
  if (!isObj(o) || !OUTPUT_KINDS.includes(o.kind)) { out.push({ path, message: `an output is one of ${OUTPUT_KINDS.join(", ")}` }); return; }
  onlyKeys(o, ["kind", "target"], path, out);
}

/** @param {string} source */
export const sourceHash = source => crypto.createHash("sha256").update(source).digest("base64url");

/**
 * Check the shape of a stored Flow. Returns every problem found (not just the first), each with a path.
 * @param {any} flow @returns {Problem[]}
 */
export function checkFlow(flow) {
  /** @type {Problem[]} */
  const out = [];
  if (!isObj(flow)) return [{ path: "", message: "a Flow is an object" }];
  onlyKeys(flow, ["format", "name", "label", "description", "authorship", "caps", "trigger", "steps"], "", out);
  if (flow.format !== FLOW_FORMAT) out.push({ path: "format", message: `format is ${FLOW_FORMAT}` });
  if (typeof flow.name !== "string" || !NAME_RE.test(flow.name)) out.push({ path: "name", message: "a Flow name is lowercase letters, digits and underscores" });
  if (flow.label !== undefined && (typeof flow.label !== "string" || flow.label.length > LIMITS.name)) out.push({ path: "label", message: "a label is a short string" });
  if (flow.description !== undefined && typeof flow.description !== "string") out.push({ path: "description", message: "a description is text" });
  if (!AUTHORSHIP.includes(flow.authorship)) out.push({ path: "authorship", message: `authorship is one of ${AUTHORSHIP.join(", ")}` });
  if (flow.caps !== undefined) {
    if (!Array.isArray(flow.caps)) out.push({ path: "caps", message: "caps are a list" });
    else flow.caps.forEach((c/** @type {any} */, i/** @type {number} */) => {
      if (!isObj(c) || typeof c.action !== "string" || !(ACTION_RE.test(c.action) || c.action === "*.*") || typeof c.resource !== "string" || !URN_RE.test(c.resource)) out.push({ path: `caps[${i}]`, message: "a cap is { action: module.verb, resource: vyre://... }" });
    });
  }
  checkTrigger(flow.trigger, out);
  const ids = new Set();
  checkSteps(flow.steps, "steps", out, ids, 0, { count: 0 });
  return out;
}

/** Canonical JSON: sorted keys, no whitespace. The one form that is hashed and approved. @param {any} v @returns {string} */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

/** @param {any} flow */
export const flowHash = flow => crypto.createHash("sha256").update(canonical(flow)).digest("base64url");

/** Walk every step, depth first, with its path. @param {any[]} steps @param {(step: any, path: string) => void} f */
export function walkSteps(steps, f, path = "steps") {
  steps.forEach((s, i) => {
    const p = `${path}[${i}]`;
    f(s, p);
    for (const b of /** @type {string[]} */ ((BLOCK_KINDS)[/** @type {keyof typeof BLOCK_KINDS} */ (s.kind)] || [])) if (Array.isArray(s[b])) walkSteps(s[b], f, `${p}.${b}`);
  });
}
