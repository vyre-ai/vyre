// @ts-check
// lib/skill-skeleton: the evidence for a learned skill, and the tools_run script it ends in (R031-00s, over R031-00o).
//
// A candidate procedure (core/learn/skills.js: a run of steps clean in three sessions) is seen in a Vyre-run thread as `thread.tool` events: each started event has the call's steps, the names of its
// arguments and its id-shaped argument values (core/switchboard/translate.js), each done event has the receipt (lib/receipt.js). This finds the run in each thread, and from the runs writes:
//   - the lines a drafting model is shown (what each call was, how it ended),
//   - the dataflow the three runs agree on (a later call's id argument was an earlier call's returned id), and
//   - a tools_run skeleton: each step with the argument names it used and <placeholders>, never a value.
// Pure. A value from any session never reaches a skill: only tool names, argument keys, and where an id came from.

/** @typedef {{ n: number, steps: string[], keys: string[], argIds: { k: string, v: string }[], receipt: any, summary: string }} Call */

/** The calls of a thread, in order, from its `thread.tool` events. @param {{ payload: any }[]} events @returns {Call[]} */
export function callsOf(events) {
  /** @type {Map<string, Call>} */ const calls = new Map();
  let n = 0;
  for (const e of events) {
    const p = e.payload || {};
    const key = String(p.call || p.id || "");
    if (!key) continue;
    if (p.phase === "started" && !calls.has(key)) calls.set(key, { n: ++n, steps: Array.isArray(p.steps) ? p.steps.map(String) : [], keys: Array.isArray(p.argKeys) ? p.argKeys.map(String) : [], argIds: Array.isArray(p.argIds) ? p.argIds : [], receipt: null, summary: String(p.summary || "") });
    else if (p.phase === "done" && calls.has(key)) /** @type {Call} */ (calls.get(key)).receipt = p.receipt || { out: p.status === "failed" ? "error" : "ok" };
  }
  return [...calls.values()].filter((c) => c.steps.length);
}

/**
 * The first run of calls whose steps, flattened, are exactly `steps` in order (a call may carry several steps, as a tools_run does; the run must start and end on a call boundary), with every call ok.
 * @param {Call[]} calls @param {string[]} steps @returns {Call[] | null}
 */
export function runFor(calls, steps) {
  const want = steps.filter((s) => s.startsWith("vyre:"));
  if (!want.length) return null;
  for (let i = 0; i < calls.length; i++) {
    /** @type {Call[]} */ const run = [];
    let k = 0;
    for (let j = i; j < calls.length && k < want.length; j++) {
      const c = calls[j];
      if (c.steps.every((s, x) => want[k + x] === s)) { run.push(c); k += c.steps.length; } else break;
    }
    if (k === want.length && run.every((c) => !c.receipt || c.receipt.out === "ok" || c.receipt.out === "held")) return run;
  }
  return null;
}

/** The dataflow within one run: which later call's id argument is an id an earlier call returned. @param {Call[]} run @returns {string[]} like "3<-1:id>client_id" (call 3's argument client_id was call 1's returned id) */
export function flowsOf(run) {
  /** @type {string[]} */ const out = [];
  run.forEach((c, j) => {
    for (const a of c.argIds) for (let i = 0; i < j; i++) {
      const r = ((run[i].receipt && run[i].receipt.ids) || []).find((/** @type {any} */ x) => x.v === a.v);
      if (r) { out.push(`${j + 1}<-${i + 1}:${r.k}>${a.k}`); break; }
    }
  });
  return out;
}

/**
 * Everything the draft needs from the runs found in the evidence sessions.
 * @param {Call[][]} runs one run per session that had one
 * @returns {{ runs: number, lines: string[][], keys: string[][], flows: string[] }}
 */
export function evidenceOf(runs) {
  const first = runs[0] || [];
  const keys = first.map((_, i) => [...new Set(runs.flatMap((r) => (r[i] ? r[i].keys : [])))].slice(0, 12));
  const flowSets = runs.map((r) => new Set(flowsOf(r)));
  // a flow counts only when every run agrees
  const flows = flowSets.length ? [...flowSets[0]].filter((f) => flowSets.every((s) => s.has(f))) : [];
  const lines = runs.map((r) => r.map((c) => `#${c.n} ${c.steps.join(" + ")} ${c.keys.length ? `(${c.keys.join(", ")})` : ""} -> ${c.receipt ? [c.receipt.out, c.receipt.n !== undefined ? `${c.receipt.n} items` : null].filter(Boolean).join(", ") : "no result seen"}`.replace(/\s+/g, " ")));
  return { runs: runs.length, lines, keys, flows };
}

/** One step as a tools_run call: [call name, input shape]. @param {string} step @param {string[]} keys */
function callOf(step, keys) {
  const body = step.slice("vyre:".length);
  const shape = Object.fromEntries(keys.map((k) => [k, `<${k}>`]));
  const m = /^work\.call:(.+)$/.exec(body);
  if (m) return { call: "work_call", input: { tool: m[1], input: shape } };
  if (body === "work.call") return { call: "work_call", input: { tool: "<tool>", input: shape } };
  return { call: body, input: shape };
}

/**
 * The tools_run script a skill ends in. Only for a procedure whose steps are all Vyre calls. Each step has the argument names it used, `<placeholders>` for values, and where the runs agreed that
 * an argument was an earlier call's returned id, `{ "expr": "steps.s1.<path to its id>" }` (the path is left for the agent to read off the earlier result: it is not guessed).
 * @param {string[]} steps @param {ReturnType<typeof evidenceOf>} ev @returns {string | null}
 */
export function skeletonOf(steps, ev) {
  if (!steps.length || !steps.every((s) => s.startsWith("vyre:")) || !ev || !ev.runs) return null;
  const links = ev.flows.map((f) => { const m = /^(\d+)<-(\d+):(.+)>(.+)$/.exec(f); return m ? { to: Number(m[1]), from: Number(m[2]), key: m[3], arg: m[4] } : null; }).filter(Boolean);
  const script = { steps: steps.map((s, i) => {
    const c = callOf(s, ev.keys[i] || []);
    const inner = /** @type {any} */ (c.input).input && typeof /** @type {any} */ (c.input).input === "object" ? /** @type {any} */ (c.input).input : c.input;
    for (const l of /** @type {any[]} */ (links)) if (l.to === i + 1 && l.arg in inner) inner[l.arg] = { expr: `steps.s${l.from}.<path to the ${l.key} the earlier call returned>` };
    return { id: `s${i + 1}`, ...c };
  }) };
  return JSON.stringify(script, null, 2);
}
