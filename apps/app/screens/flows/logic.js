// Flows, as pure functions: a Flow's steps laid out as a graph (the shape the kernel's canvas API returns), a run painted over it,
// the Flow as code, and Kit diffs in words. A real source returns the graph and the painted run itself; these keep the screens honest
// about the shape until it does.

/** @typedef {{ id: string, kind: string, label: string, who?: string, outward?: boolean, sealed?: boolean, code?: boolean, waits?: boolean, args?: string, then?: Step[], else?: Step[], each?: Step[] }} Step */
/** @typedef {{ id: string, name: string, trigger: string, triggerCode: string, steps: Step[] }} Def */

/**
 * The Flow as nodes and edges: a trigger first, then one row per step, top to bottom. A decide has a "then" lane and an "else" lane, a repeat an "each" lane.
 * The same shape as kernel canvas.graph: { id, kind, label, lane, y, outward, sealed, waits } and { from, to, kind }.
 * @param {Def} flow
 */
export function buildGraph(flow) {
  /** @type {any[]} */ const nodes = [{ id: "trigger", kind: "trigger", label: flow.trigger, lane: 0, y: 0 }];
  /** @type {{ from: string, to: string, kind: 'next'|'then'|'else'|'each' }[]} */ const edges = [];
  let row = 1;
  /** @param {Step[]} steps @param {number} lane @param {string} from @param {'next'|'then'|'else'|'each'} first */
  const lay = (steps, lane, from, first) => {
    let prev = from, kind = first;
    for (const s of steps) {
      const y = row++;
      nodes.push({ id: s.id, kind: s.kind, label: s.label, who: s.who, lane, y, outward: s.outward || undefined, sealed: s.sealed || undefined, code: s.code || undefined, waits: s.waits || ["wait", "ask"].includes(s.kind) || undefined });
      edges.push({ from: prev, to: s.id, kind });
      kind = "next"; prev = s.id;
      if (s.then) lay(s.then, lane + 1, s.id, "then");
      if (s.else) lay(s.else, lane + 2, s.id, "else");
      if (s.each) lay(s.each, lane + 1, s.id, "each");
    }
  };
  lay(flow.steps, 0, "trigger", "next");
  return { nodes, edges };
}

/**
 * Paint a run over a graph. `at` is the node the run waits at (null: the run finished). Rows above it are done, it is waiting (or failed), rows below are pending.
 * @template {{ id: string, y: number }} N @param {N[]} nodes @param {string|null} at @param {'waiting'|'failed'|'paused'} [kind] @param {string} [note]
 */
export function paint(nodes, at, kind = "waiting", note) {
  const stop = at ? nodes.find((n) => n.id === at)?.y ?? Infinity : Infinity;
  return nodes.map((n) => {
    const state = n.y < stop ? "done" : n.y === stop ? kind : "pending";
    return { ...n, state: /** @type {'done'|'waiting'|'failed'|'paused'|'pending'} */ (state), ...(n.y === stop && note ? { note } : {}) };
  });
}

/** The Flow as TypeScript text ("See as code"). @param {Def} flow */
export function flowCode(flow) {
  /** @param {Step[]} steps @param {string} pad @returns {string[]} */
  const lines = (steps, pad) => steps.flatMap((s) => {
    const head = `${pad}step.${s.kind}('${s.id}', { ${s.args ?? ""}`;
    const inner = [["then", s.then], ["else", s.else], ["steps", s.each]].filter(([, v]) => v);
    if (!inner.length) return [`${head} }),`];
    return [head + (s.args ? "," : ""), ...inner.flatMap(([k, v]) => [`${pad}  ${k}: [`, ...lines(/** @type {Step[]} */ (v), pad + "    "), `${pad}  ],`]), `${pad}}),`];
  });
  return ["import { defineFlow, step } from '@vyre/sdk';", `export default defineFlow({`, `  name: '${flow.id}', authorship: 'human',`, `  trigger: { ${flow.triggerCode} },`, "  steps: [", ...lines(flow.steps, "    "), "  ],", "});"].join("\n");
}

/** The count of steps a person must say yes to. @param {Step[]} steps @returns {number} */
export const asksIn = (steps) => steps.reduce((n, s) => n + (s.kind === "ask" ? 1 : 0) + asksIn(s.then ?? []) + asksIn(s.else ?? []) + asksIn(s.each ?? []), 0);

/** A short sentence of what a Kit adds, from its install card: "2 record types, 3 Flows, 4 views, 1 role". @param {{ types?: number, flows?: number, views?: number, roles?: number }} adds */
export function addsLine(adds) {
  /** @param {number|undefined} n @param {string} one @param {string} many */
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : "");
  return [part(adds.types, "record type", "record types"), part(adds.flows, "Flow", "Flows"), part(adds.views, "view", "views"), part(adds.roles, "role", "roles")].filter(Boolean).join(", ");
}

/** The icon of what starts a Flow: a payment is a card, a matter entering a stage is the board, anything on a time is a clock. @param {{ triggerCode: string }} flow @returns {"card"|"board"|"clock"} */
export function triggerIcon(flow) {
  const c = flow.triggerCode;
  return /payment/.test(c) ? "card" : /stage/.test(c) ? "board" : "clock";
}

/** Line 2 of a Flow row: what starts it, short ("On payment received", "On matter entering Intake"). @param {{ trigger: string, triggerCode: string }} flow */
export function triggerLine(flow) {
  const c = flow.triggerCode;
  if (/payment\.received/.test(c)) return "On payment received";
  const stage = /stage:\s*'([^']+)'/.exec(c)?.[1];
  const type = /type:\s*'([^']+)'/.exec(c)?.[1];
  if (stage) return `On ${type ?? "record"} entering ${stage}`;
  return `On ${flow.trigger.replace(/^An? /, "").replace(/ is /, " ").toLowerCase()}`;
}
