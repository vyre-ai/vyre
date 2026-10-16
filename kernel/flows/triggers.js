// @ts-check
// The trigger registry (team/0.3/DESIGN-flows-joints.md, section 2). A Flow starts from one trigger node, and there are five kinds and no others. A kind is one entry here:
// which stored `on` values it covers, how its shape is checked, how it reads in plain words, which names an expression may read, and how it is armed. Adding a kind is adding
// an entry; the schema, the compiler, the canvas, the text form and the runner all read this table.
//
//   kind        stored `on`        started by                                               armed by (runner)
//   watcher     watcher            something new in a watched place (a mailbox, a folder)   runner.watcherItem(), called by whatever hosts watchers
//   schedule    time               the Space's clock (cron or every, in the Space's zone)   runner.tick(), one timer set to runner.nextWake()
//   record      event, stage       a record is created, changes, is removed, enters a stage runner.onEvent(), one subscription to the event log
//   form        web                a form is submitted or an inbound hook is called         runner.handleWeb(), the Ingress door's labelled call
//   person      manual             someone or an assistant runs it                          runner.start(), through the tasks path under their own chain

import { validTimeZone } from "./zone.js";
import { SCHEDULE_KEYS, checkSchedule, describeWindow } from "./schedule.js";
import { parse, evaluate, truthy } from "./expr.js";

/** @typedef {{ path: string, message: string }} Problem */
/**
 * What schema.js hands the checks, so this file imports nothing from it.
 * @typedef {{ onlyKeys: (o: any, allowed: string[], path: string, out: Problem[]) => void, checkExpr: (v: any, path: string, out: Problem[]) => void, EVENT_RE: RegExp, NAME_RE: RegExp }} Helpers
 */

const span = (/** @type {number} */ ms) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} minute${m === 1 ? "" : "s"}` : m < 1440 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? "" : "s"}` : `${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? "" : "s"}`; };
export const WATCHER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * @typedef {{
 *   kind: string, on: readonly string[], label: string, icon: string, armed: string,
 *   scope: readonly string[],
 *   keys: readonly string[],
 *   words: (t: any) => string,
 *   check: (t: any, out: Problem[], h: Helpers) => void,
 *   source: (t: any) => string,
 * }} TriggerKind
 */

/** @type {Record<string, TriggerKind>} */
export const TRIGGER_REGISTRY = Object.freeze({
  watcher: {
    kind: "watcher", on: ["watcher"], label: "Watcher", icon: "eye", armed: "runner.watcherItem({ watcher, item })",
    scope: ["trigger"], keys: ["on", "watcher", "where"],
    words: t => `When the watcher ${t.watcher} finds something new${t.where ? " that matches" : ""}`,
    check(t, out, h) {
      h.onlyKeys(t, ["on", "watcher", "where"], "trigger", out);
      if (typeof t.watcher !== "string" || !WATCHER_NAME_RE.test(t.watcher)) out.push({ path: "trigger.watcher", message: "name the watcher (lowercase letters, digits, dots, dashes and underscores)" });
      if (t.where !== undefined) h.checkExpr(t.where, "trigger.where", out);
    },
    source: t => `watcher:${t.watcher}`,
  },
  schedule: {
    kind: "schedule", on: ["time"], label: "Schedule", icon: "clock", armed: "runner.tick() at runner.nextWake()",
    scope: ["trigger"], keys: ["on", "cron", "every_ms", "at", "tz", ...SCHEDULE_KEYS],
    words: t => `${t.cron ? `On a schedule (${t.cron}${t.tz ? `, ${t.tz}` : ""})` : t.every_ms ? `Every ${span(t.every_ms)}` : "At a set time"}${describeWindow(t) ? `, ${describeWindow(t)}` : ""}`,
    check(t, out, h) {
      h.onlyKeys(t, ["on", "cron", "every_ms", "at", "tz", ...SCHEDULE_KEYS], "trigger", out);
      checkSchedule(t, out);
      if ([t.cron, t.every_ms, t.at].filter(x => x !== undefined).length !== 1) out.push({ path: "trigger", message: "a time trigger has exactly one of cron, every_ms or at" });
      if (t.cron !== undefined && typeof t.cron !== "string") out.push({ path: "trigger.cron", message: "cron is a five-field string" });
      if (t.every_ms !== undefined && !(Number.isInteger(t.every_ms) && t.every_ms >= 60_000)) out.push({ path: "trigger.every_ms", message: "a repeat is a whole number of milliseconds, at least a minute" });
      if (t.at !== undefined && !Number.isInteger(t.at)) out.push({ path: "trigger.at", message: "at is a time in milliseconds" });
      // The zone is the Space's unless the trigger names one (a schedule for a branch office); a cron line and business hours read a wall clock, an interval alone does not.
      if (t.tz !== undefined && ((t.cron === undefined && t.hours === undefined) || !validTimeZone(t.tz))) out.push({ path: "trigger.tz", message: t.cron === undefined && t.hours === undefined ? "a time zone goes with a cron schedule or business hours" : "that is not a time zone name (use one like America/Los_Angeles)" });
    },
    source: t => `schedule:${t.cron ? `cron ${t.cron}` : t.every_ms ? `every ${t.every_ms}ms` : `at ${t.at}`}`,
  },
  record: {
    kind: "record", on: ["event", "stage"], label: "Record event", icon: "bolt", armed: "runner.onEvent(env)",
    scope: ["trigger", "event"], keys: ["on", "event", "where", "field", "when_record_changes", "type", "stage"],
    words: t => (t.on === "stage" ? `When a ${t.type} enters ${t.stage}` : `When ${eventPatterns(t).join(" or ")} happens${t.field ? ` and ${t.field} changes` : ""}${t.where ? " and the condition holds" : ""}`),
    check(t, out, h) {
      if (t.on === "event") {
        h.onlyKeys(t, ["on", "event", "where", "field", "when_record_changes"], "trigger", out);
        const evs = Array.isArray(t.event) ? t.event : [t.event];
        if (!evs.length || evs.length > 4 || !evs.every(e => typeof e === "string" && h.EVENT_RE.test(e))) out.push({ path: "trigger.event", message: "an event pattern is noun.past-verb or noun.*, or a list of up to four of them" });
        if (t.field !== undefined && (typeof t.field !== "string" || !h.NAME_RE.test(t.field))) out.push({ path: "trigger.field", message: "name the field to watch (a field name)" });
        if (t.when_record_changes !== undefined && !["replace", "keep"].includes(t.when_record_changes)) out.push({ path: "trigger.when_record_changes", message: "when_record_changes is replace (start over) or keep (keep both)" });
        if (t.where !== undefined) h.checkExpr(t.where, "trigger.where", out);
      } else {
        h.onlyKeys(t, ["on", "type", "stage"], "trigger", out);
        if (typeof t.type !== "string" || !h.NAME_RE.test(t.type)) out.push({ path: "trigger.type", message: "the record type is a name" });
        if (typeof t.stage !== "string" || !t.stage) out.push({ path: "trigger.stage", message: "name the stage" });
      }
    },
    source: t => (t.on === "stage" ? `record:${t.type} enters ${t.stage}` : `record:${eventPatterns(t).join("|")}`),
  },
  form: {
    kind: "form", on: ["web"], label: "Form or hook", icon: "inbox", armed: "runner.handleWeb(path, { body, trust })",
    scope: ["trigger"], keys: ["on", "path"],
    words: t => `When something calls /${t.path}`,
    check(t, out, h) {
      h.onlyKeys(t, ["on", "path"], "trigger", out);
      if (typeof t.path !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(t.path)) out.push({ path: "trigger.path", message: "a web trigger path is lowercase letters, digits and hyphens" });
    },
    source: t => `web:/${t.path}`,
  },
  person: {
    kind: "person", on: ["manual"], label: "A person or assistant", icon: "hand", armed: "runner.start(id, input, chain)",
    scope: ["trigger"], keys: ["on", "input"],
    words: () => "When someone runs it",
    check(t, out, h) { h.onlyKeys(t, ["on", "input"], "trigger", out); },
    source: () => "manual",
  },
});

/** The event patterns of a record trigger: `event` is one pattern or a short list. @param {any} t @returns {string[]} */
export function eventPatterns(t) { return Array.isArray(t && t.event) ? t.event : t && typeof t.event === "string" ? [t.event] : []; }

/** Does a record event pass the trigger's `field` filter? Only a change (`noun.updated`) is filtered: a creation always passes. @param {any} t @param {any} env */
export function fieldPasses(t, env) {
  if (!t || !t.field || !/\.updated$/.test(String(env.type))) return true;
  return Array.isArray(env.data && env.data.changed) && env.data.changed.includes(t.field);
}

/**
 * What happens to an earlier run for the same record when the record changes again: `replace` (start over: its waiting run is cancelled) or `keep` (both go on, as before). The default is
 * `replace` only for a trigger that says "created or updated"; every other trigger keeps today's behaviour. @param {any} t @returns {"replace" | "keep"}
 */
export function onRecordChange(t) {
  if (!t || t.on !== "event") return "keep";
  if (t.when_record_changes) return t.when_record_changes;
  const ev = eventPatterns(t);
  return ev.some(e => /\.created$/.test(e)) && ev.some(e => /\.updated$/.test(e)) ? "replace" : "keep";
}

/** The stored `on` values, in registry order: what a Flow's trigger may say. */
export const TRIGGER_ONS = Object.freeze(Object.values(TRIGGER_REGISTRY).flatMap(k => [...k.on]));
/** Every key a trigger may carry, in the order the text form prints them. */
export const TRIGGER_KEY_ORDER = Object.freeze([...new Set(Object.values(TRIGGER_REGISTRY).flatMap(k => [...k.keys]))]);

/** The registry entry for a stored trigger, or null. @param {any} t */
export function kindOf(t) { return t && typeof t === "object" ? Object.values(TRIGGER_REGISTRY).find(k => k.on.includes(t.on)) || null : null; }

/** Check a trigger's shape against its kind. @param {any} t @param {Problem[]} out @param {Helpers} h */
export function checkTrigger(t, out, h) {
  const k = kindOf(t);
  if (!k) { out.push({ path: "trigger", message: `a trigger is one of ${TRIGGER_ONS.join(", ")}` }); return; }
  k.check(t, out, h);
}

/** The trigger in plain words, for the canvas and the approval card. @param {any} t */
export function describeTrigger(t) { const k = kindOf(t); return k ? k.words(t) : String(t && t.on); }

/** The names an expression in this Flow may read from the trigger (`trigger.item.subject`, `event.data`). @param {any} t */
export function triggerScopeNames(t) { const k = kindOf(t); return k ? [...k.scope] : ["trigger"]; }

/** A short, stable account of what started a run, for the run record: `watcher:mail`, `schedule:cron 0 7 * * 1-5`. @param {any} t */
export function triggerSource(t) { const k = kindOf(t); return k ? k.source(t) : String(t && t.on); }

/** The kind's plain label ("Watcher") for a stored `on`. @param {string} on */
export function kindLabel(on) { const k = Object.values(TRIGGER_REGISTRY).find(x => x.on.includes(on)); return k ? k.label : on; }

/**
 * Why a run happened, in one sentence, from the run's own record of its trigger ("Why did this run" is one click). Never reads past what the record kept, and the record never kept
 * a sealed value.
 * @param {{ kind?: string, source?: string, at?: number, key?: string, input?: any, event?: any, caught_up?: boolean, missed?: number } | undefined} t
 */
export function whyRan(t) {
  if (!t || !t.kind) return "It was started, but this run did not record how.";
  const src = t.source || t.kind;
  const sample = (/** @type {any} */ v) => { if (v === undefined || v === null) return ""; const o = typeof v === "object" ? (v.title || v.subject || v.name || v.id || "") : String(v); return o ? ` (${String(o).slice(0, 80)})` : ""; };
  switch (t.kind) {
    case "watcher": return `The watcher ${src.replace(/^watcher:/, "")} found something new${sample(t.input)}.`;
    case "time": return t.caught_up ? `The server had been off, so the schedule ran once to catch up${t.missed ? `, skipping ${t.missed} earlier time${t.missed === 1 ? "" : "s"}` : ""}.` : "Its schedule came round.";
    case "event": case "stage": return `A record event started it: ${src.replace(/^record:/, "")}.`;
    case "web": return `Something called ${src.replace(/^web:/, "")}${sample(t.input)}.`;
    case "manual": return `Someone ran it${sample(t.input)}.`;
    case "branch": return "It is one lane of a parallel step in another run.";
    case "subflow": return "Another Flow ran it as a step.";
    default: return `Started by ${src}.`;
  }
}

const INPUT_CAP = 64 * 1024;
/** A sealed value as the kernel shapes it: never copied into a run record. @param {any} v */
const sealedShape = v => v !== null && typeof v === "object" && !Array.isArray(v) && Object.hasOwn(v, "sealed");
/**
 * What a run record keeps of the input that started it: capped, and with any sealed value replaced by a marker (the trigger's input is data from outside; the record is for "why did this
 * run", not a second copy of it). @param {any} v @param {number} [cap]
 */
export function scrubInput(v, cap = INPUT_CAP) {
  const walk = (/** @type {any} */ x, /** @type {number} */ depth) => {
    if (sealedShape(x)) return { sealed: true };
    if (Array.isArray(x)) return depth > 6 ? "[too deep]" : x.slice(0, 50).map(y => walk(y, depth + 1));
    if (x !== null && typeof x === "object") { /** @type {Record<string, any>} */ const o = {}; for (const k of Object.keys(x).slice(0, 50)) { if (k === "__proto__") continue; o[k] = depth > 6 ? "[too deep]" : walk(x[k], depth + 1); } return o; }
    return typeof x === "string" && x.length > 1000 ? x.slice(0, 1000) : x;
  };
  const out = walk(v, 0);
  const text = JSON.stringify(out);
  return text.length > cap ? { truncated: true, bytes: text.length, head: text.slice(0, 512) } : out;
}

/**
 * The trigger as a run records it: which kind fired, from what source, when, and with what. `slim` shapes an event envelope.
 * @param {any} t the Flow's trigger @param {{ kind: string, key: string, event?: any, input?: any, path?: string, at?: number, caught_up?: boolean, missed?: number, tz?: string }} trig @param {(e: any) => any} slim
 */
export function recordTrigger(t, trig, slim) {
  return {
    kind: trig.kind, key: trig.key, source: triggerSource(t),
    ...(trig.at !== undefined ? { at: trig.at } : {}),
    ...(trig.event ? { event: slim(trig.event) } : {}),
    ...(trig.input !== undefined ? { input: scrubInput(trig.input) } : {}),
    ...(trig.path ? { path: trig.path } : {}),
    ...(trig.caught_up ? { caught_up: true, missed: trig.missed || 0 } : {}),
    ...(trig.tz ? { tz: trig.tz } : {}),
  };
}

/** Does an event pattern (`noun.past-verb`, `noun.*`) match a type? @param {string} pattern @param {string} type */
export const typeMatches = (pattern, type) => pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));

/**
 * Does this event trigger this Flow? Returns the scope the Flow reads (`trigger` and `event`), or null. An error in the condition is "no".
 * @param {any} t the Flow's trigger @param {any} env an event envelope
 */
export function triggerScope(t, env) {
  let scope = null;
  if (t.on === "event" && eventPatterns(t).some(e => typeMatches(e, env.type)) && fieldPasses(t, env)) scope = { trigger: env.data ?? {}, event: env };
  else if (t.on === "stage" && env.type === "record.stage-entered" && env.data && env.data.type === t.type && env.data.stage === t.stage) scope = { trigger: env.data, event: env };
  if (!scope) return null;
  if (t.on === "event" && t.where) { try { if (!truthy(evaluate(parse(t.where), scope))) return null; } catch { return null; } }
  return scope;
}
