// @ts-check
// What the Flow canvas needs from the kernel side (native-core builds the screen to the prototype): the graph of a Flow in plain words, a run painted
// over it, "See as code" in both directions, a diff in plain words, and the builder's edits as small pure functions over the stored form.
// Everything here is data in, data out. Nothing draws.

import { printFlow, parseFlowText } from "./text.js";
import { compileFlow } from "./compile.js";
import { describeTrigger, kindOf, whyRan } from "./triggers.js";
export { describeTrigger };
import { canonical, flowHash, walkSteps, BLOCK_KINDS } from "./schema.js";

const ICON = { find: "search", pick: "search", filter: "filter", create: "plus", update: "edit", upsert: "edit", remove: "trash", decide: "branch", repeat: "loop", wait: "clock", ask: "question", assign: "person", agent: "assistant", call: "send", stage: "stage", classify: "tag", extract: "tag", service: "globe", fn: "code" };

/** @param {import('./compile.js').Catalog} cat @param {string} type */
const typeLabel = (cat, type) => ((cat.types[type] && cat.types[type].label) || type).toLowerCase();

/** @param {number} ms */
function span(ms) {
  if (ms % 86_400_000 === 0 && ms >= 86_400_000) { const d = ms / 86_400_000; return `${d} ${d === 1 ? "day" : "days"}`; }
  if (ms % 3_600_000 === 0 && ms >= 3_600_000) { const h = ms / 3_600_000; return `${h} ${h === 1 ? "hour" : "hours"}`; }
  if (ms % 60_000 === 0 && ms >= 60_000) { const m = ms / 60_000; return `${m} ${m === 1 ? "minute" : "minutes"}`; }
  return `${Math.round(ms / 1000)} seconds`;
}

/** @param {string} who */
function whoLabel(who) { const [k, ...r] = String(who).split(":"); const n = r.join(":"); return k === "role" ? `the ${n}` : k === "teammate" ? n.charAt(0).toUpperCase() + n.slice(1) : n; }

/**
 * One step in a sentence a person can read. No ids, no jargon.
 * @param {any} s @param {import('./compile.js').Catalog} cat
 */
export function describeStep(s, cat) {
  const act = (cat.actions[s.action] && cat.actions[s.action].label) || String(s.action || "").replace(".", " ");
  switch (s.kind) {
    case "find": return `Look up ${typeLabel(cat, s.type)} records${s.where ? " that match" : ""}`;
    case "pick": return `Pick the first matching ${typeLabel(cat, s.type)}`;
    case "filter": return "Keep only the ones that match";
    case "create": return `Create a ${typeLabel(cat, s.type)}`;
    case "update": return `Change a ${typeLabel(cat, s.type)}`;
    case "upsert": return `Create or change a ${typeLabel(cat, s.type)}`;
    case "remove": return `Remove a ${typeLabel(cat, s.type)}`;
    case "decide": return "Decide";
    case "repeat": return `Do this for each ${s.as}`;
    case "wait": return s.for_ms !== undefined ? `Wait ${span(s.for_ms)}` : s.event ? `Wait for ${s.event}` : "Wait until a time";
    case "ask": return `Ask ${whoLabel(s.to)}`;
    case "assign": return `Give a task to ${whoLabel(s.to)}`;
    case "agent": return `Have ${whoLabel(s.assistant)} work on it`;
    case "call": return act.charAt(0).toUpperCase() + act.slice(1);
    case "stage": return `Move the ${typeLabel(cat, s.type)} to ${s.to}`;
    case "classify": return "Sort the text into a label";
    case "extract": return "Read named fields out of the text";
    case "service": return `Call ${s.connector}${s.method === "GET" || s.method === "HEAD" ? "" : " (needs a yes)"}`;
    case "fn": return "Run a small piece of code";
    default: return s.kind;
  }
}

/**
 * The Flow as nodes and edges, with a simple top-to-bottom layout (x is the lane, y the row). A decide has a `then` and an `else` lane, a repeat an inside lane.
 * @param {any} flow @param {import('./compile.js').Catalog} cat
 */
export function graph(flow, cat) {
  const compiled = compileFlow(flow, cat);
  const risky = new Set(compiled.effects.outward.map(o => o.step));
  const sealed = new Set(compiled.effects.sealed_uses.map(u => u.path.replace(/\.[^.]*$/, "")));
  /** @type {any[]} */ const nodes = [{ id: "trigger", kind: "trigger", trigger_kind: (kindOf(flow.trigger) || {}).kind, label: describeTrigger(flow.trigger), icon: (kindOf(flow.trigger) || {}).icon || "bolt", x: 0, y: 0, lane: 0 }];
  /** @type {any[]} */ const edges = [];
  let row = 1;
  /** @param {any[]} steps @param {number} lane @param {string} from @param {string} edgeKind @returns {string} the last node id in this lane */
  const lay = (steps, lane, from, edgeKind) => {
    let prev = from, kind = edgeKind;
    for (const s of steps) {
      const y = row++;
      nodes.push({ id: s.id, kind: s.kind, label: s.label || describeStep(s, cat), icon: ICON[/** @type {keyof typeof ICON} */ (s.kind)] || "step", x: lane, y, lane, outward: risky.has(s.id), sealed: [...sealed].some(p => p.includes(s.id)) || undefined, code: s.kind === "fn" || undefined, waits: ["wait", "ask"].includes(s.kind) || (s.kind === "agent" && s.await !== false) || undefined });
      edges.push({ from: prev, to: s.id, kind });
      kind = "next";
      prev = s.id;
      if (s.kind === "decide") {
        const t = lay(s.then || [], lane + 1, s.id, "then");
        const e = s.else && s.else.length ? lay(s.else, lane + 2, s.id, "else") : null;
        // after a decide, the flow carries on from the decide itself; the branches rejoin implicitly
        void t; void e;
      } else if (s.kind === "repeat") lay(s.steps || [], lane + 1, s.id, "each");
    }
    return prev;
  };
  lay(flow.steps, 0, "trigger", "next");
  return { nodes, edges, trigger: describeTrigger(flow.trigger), warnings: compiled.warnings, ok: compiled.ok };
}

/**
 * Paint a run over the graph: each node gets a state (waiting, done, failed, skipped, pending), a short result, and why it stopped.
 * @param {any} flow @param {any} run @param {import('./compile.js').Catalog} cat
 */
export function paintRun(flow, run, cat) {
  const g = graph(flow, cat);
  /** @param {string} id @returns {any[]} */
  const entries = id => Object.entries(run.steps).filter(([k]) => !k.includes("?") && k.replace(/@.*$/, "") === id).map(([, v]) => v);
  const nodes = g.nodes.map(n => {
    if (n.id === "trigger") return { ...n, state: "done", note: run.tainted ? "Started from outside this Space" : undefined, why: whyRan(run.trigger), fired: run.trigger ? { kind: run.trigger.kind, source: run.trigger.source, at: run.trigger.at, caught_up: run.trigger.caught_up, missed: run.trigger.missed } : undefined };
    const es = entries(n.id);
    const ask = Object.entries(run.steps).filter(([k]) => k.startsWith(n.id) && k.endsWith("?ask")).map(([, v]) => v)[0];
    let state = "pending", note;
    if (es.some(e => e.status === "failed")) state = "failed";
    else if (es.some(e => e.status === "waiting") || (ask && ask.status === "waiting")) { state = "waiting"; note = ask && ask.status === "waiting" ? "Waiting for a person's yes" : "Waiting"; }
    else if (es.length && es.every(e => e.status === "done")) state = "done";
    else if (es.some(e => e.status === "started")) state = "running";
    if (run.error && run.error.step === n.id && run.error.code && run.error.code !== "note" && ["failed", "paused"].includes(run.state)) { state = run.state === "paused" ? "paused" : "failed"; note = run.error.message; }
    return { ...n, state, count: es.length > 1 ? es.length : undefined, note };
  });
  return { nodes, edges: g.edges, trigger: run.trigger || null, why: whyRan(run.trigger), state: run.state, error: run.error && run.error.code && run.error.code !== "note" ? run.error : null, tainted: run.tainted };
}

/** "See as code": the Flow as TypeScript text, and the hash that an approval binds to. @param {any} flow */
export function seeAsCode(flow) { return { text: printFlow(flow), hash: flowHash(flow) }; }

/**
 * Edit as code: parse what the person typed, check it against the Space's types, and say in words what changed from the stored Flow. Nothing is saved here.
 * @param {string} text @param {any} stored the Flow as it is now, or null for a new one @param {import('./compile.js').Catalog} cat
 */
export function fromCode(text, stored, cat) {
  let parsed;
  try { parsed = parseFlowText(text); }
  catch (e) { const x = /** @type {any} */ (e); return { ok: false, errors: [{ path: x.line ? `line ${x.line}` : "", message: x.detail || x.message }], changes: [] }; }
  if (parsed.problems.length) return { ok: false, errors: parsed.problems, changes: [] };
  const flow = parsed.flows[0].flow;
  const compiled = compileFlow(flow, cat);
  return { ok: compiled.ok, errors: compiled.errors, warnings: compiled.warnings, flow, hash: flowHash(flow), effects: compiled.effects, changes: stored ? flowChanges(stored, flow, cat) : [], same: stored ? canonical(stored) === canonical(flow) : false };
}

/**
 * What changed between two versions of a Flow, in plain words, for the approval card and the history.
 * @param {any} a @param {any} b @param {import('./compile.js').Catalog} cat
 */
export function flowChanges(a, b, cat) {
  /** @type {string[]} */ const out = [];
  if (canonical(a.trigger) !== canonical(b.trigger)) out.push(`The trigger changes: ${describeTrigger(a.trigger)} becomes ${describeTrigger(b.trigger)}.`);
  if (a.authorship !== b.authorship) out.push(`Who made it changes from ${a.authorship} to ${b.authorship}.`);
  if ((a.label || a.name) !== (b.label || b.name)) out.push(`It is renamed to ${b.label || b.name}.`);
  if (canonical(a.caps || null) !== canonical(b.caps || null)) out.push("Its declared powers change.");
  /** @type {Map<string, any>} */ const am = new Map(), bm = new Map();
  walkSteps(a.steps, s => am.set(s.id, s));
  walkSteps(b.steps, s => bm.set(s.id, s));
  for (const [id, s] of bm) if (!am.has(id)) out.push(`Adds a step: ${describeStep(s, cat)}.`);
  for (const [id, s] of am) if (!bm.has(id)) out.push(`Removes a step: ${describeStep(s, cat)}.`);
  for (const [id, s] of bm) {
    const o = am.get(id);
    if (!o) continue;
    const strip = (/** @type {any} */ x) => { const c = { ...x }; for (const k of Object.keys(BLOCK_KINDS)) void k; for (const bk of /** @type {string[]} */ (BLOCK_KINDS[/** @type {keyof typeof BLOCK_KINDS} */ (x.kind)] || [])) delete c[bk]; return canonical(c); };
    if (strip(o) !== strip(s)) out.push(`Changes a step: ${describeStep(s, cat)}.`);
  }
  const order = (/** @type {any} */ f) => { /** @type {string[]} */ const ids = []; walkSteps(f.steps, s => ids.push(s.id)); return ids.filter(id => am.has(id) && bm.has(id)).join(","); };
  if (order(a) !== order(b)) out.push("Steps are in a different order.");
  return out;
}

// ---------------------------------------------------------------- the builder's edits, on the stored form

/** Find a step and the list that holds it. @param {any[]} steps @param {string} id @returns {{ list: any[], index: number }|null} */
function locate(steps, id) {
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].id === id) return { list: steps, index: i };
    for (const b of /** @type {string[]} */ (BLOCK_KINDS[/** @type {keyof typeof BLOCK_KINDS} */ (steps[i].kind)] || [])) if (Array.isArray(steps[i][b])) { const r = locate(steps[i][b], id); if (r) return r; }
  }
  return null;
}

/** The builder's edits. Each returns a new Flow (the input is never changed) and the problems the shape check finds, if any. */
export const ops = Object.freeze({
  /** Add a step after another (or first, with after = null; or into a block with { into: id, block }). @param {any} flow @param {any} step @param {string|null} after @param {{ into?: string, block?: string }} [at] */
  addStep(flow, step, after, at = {}) {
    const f = structuredClone(flow);
    if (at.into) { const host = locate(f.steps, at.into); if (!host) throw new Error("no such step"); const s = host.list[host.index]; const block = at.block || (BLOCK_KINDS[/** @type {keyof typeof BLOCK_KINDS} */ (s.kind)] || [])[0]; if (!block) throw new Error("that step holds no steps"); s[block] = s[block] || []; s[block].push(step); }
    else if (after === null) f.steps.unshift(step);
    else { const l = locate(f.steps, after); if (!l) throw new Error("no such step"); l.list.splice(l.index + 1, 0, step); }
    return f;
  },
  /** @param {any} flow @param {string} id */
  removeStep(flow, id) { const f = structuredClone(flow); const l = locate(f.steps, id); if (!l) throw new Error("no such step"); l.list.splice(l.index, 1); return f; },
  /** @param {any} flow @param {string} id @param {Record<string, any>} patch a key set to undefined is removed */
  updateStep(flow, id, patch) {
    const f = structuredClone(flow); const l = locate(f.steps, id); if (!l) throw new Error("no such step");
    const s = l.list[l.index];
    for (const [k, v] of Object.entries(patch)) { if (k === "id" || k === "kind") throw new Error("a step keeps its id and kind"); if (v === undefined) delete s[k]; else s[k] = v; }
    return f;
  },
  /** Move a step within its list by an offset. @param {any} flow @param {string} id @param {number} by */
  moveStep(flow, id, by) {
    const f = structuredClone(flow); const l = locate(f.steps, id); if (!l) throw new Error("no such step");
    const to = Math.max(0, Math.min(l.list.length - 1, l.index + by));
    const [s] = l.list.splice(l.index, 1); l.list.splice(to, 0, s);
    return f;
  },
  /** @param {any} flow @param {any} trigger */
  setTrigger(flow, trigger) { return { ...structuredClone(flow), trigger }; },
});
