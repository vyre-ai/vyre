// @ts-check
// Round-trip property tests (roadmap 0.6 item 5): Flows and expressions made by a seeded generator go through the TypeScript text form and the lines form and come back as the same Flow, and printing what came
// back prints the same text. The generator draws on the safety net's own step scenarios (every step kind), then adds the options a step and a Flow may carry. The same seed gives the same Flows, so a failure is
// reproducible: the message names the seed and the iteration.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world } from "./testing/world.js";
import { checkFlow } from "./schema.js";
import { parse, ExprError } from "./expr.js";
import { printFlow, parseFlowText, normalizeFlow, sameFlow } from "./text.js";
import { printLines, parseLines } from "./lines.js";
import { SCENARIOS } from "./safety-net.js";

/** @param {number} seed */
const prng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
/** @template T @param {() => number} r @param {T[]} xs @returns {T} */
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];

const CHARS = ["a", "b", " ", "\"", "\\", "`", "${", "\n", "\t", "é", "{", "}", "'", "#", "x1", "-"];
/** A string literal of the expression language holding odd characters, written the way the language reads it. @param {() => number} r */
const literal = r => { let s = ""; for (let i = 0, n = 1 + Math.floor(r() * 6); i < n; i++) s += pick(r, CHARS); return `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`; };
/** A random expression the language accepts (depth and size stay within expr.js limits). @param {() => number} r @param {number} depth @returns {string} */
const expr = (r, depth = 0) => {
  if (depth > 2 || r() < 0.35) return pick(r, [() => `trigger.${pick(r, ["client", "amount", "n", "after.status"])}`, () => String(Math.floor(r() * 1000)), () => literal(r), () => pick(r, ["true", "false", "null"])])();
  switch (Math.floor(r() * 5)) {
    case 0: return `(${expr(r, depth + 1)} ${pick(r, ["+", "-", "*", "==", "!=", "<", ">", "and", "or"])} ${expr(r, depth + 1)})`;
    case 1: return `not ${expr(r, depth + 1)}`;
    case 2: return `${pick(r, ["lower", "upper", "trim", "len", "text", "number", "isnull"])}(${expr(r, depth + 1)})`;
    case 3: return `coalesce(${expr(r, depth + 1)}, ${expr(r, depth + 1)})`;
    default: return `round(${expr(r, depth + 1)})`;
  }
};
/** @param {() => number} r @param {number} [depth] */
const validExpr = (r, depth = 0) => { for (let i = 0; i < 24; i++) { const e = expr(r, depth); try { parse(e); return e; } catch (e) { if (!(e instanceof ExprError)) throw e; } } return "trigger.client"; };

/** @param {() => number} r @param {any} s a step that may carry a failure policy */
const withPolicy = (r, s) => {
  const out = { ...s };
  if (r() < 0.5) out.retry = r() < 0.3 ? false : { attempts: 1 + Math.floor(r() * 5), backoff_ms: pick(r, [0, 1000, [1000, 5000]]), on: pick(r, [["timeout"], ["timeout", "unavailable"], ["busy"]]) };
  if (r() < 0.4 && s.kind !== "wait") out.timeout_ms = 1000 * (1 + Math.floor(r() * 3000));
  if (r() < 0.4) out.verify = { check: validExpr(r, 2), essential: r() < 0.5, ...(r() < 0.5 ? { say: "Not what was expected." } : {}) };
  if (r() < 0.4) out.on_fail = { then: pick(r, ["stop", "continue"]), steps: [{ id: `oops_${Math.floor(r() * 1e9).toString(36)}`, kind: "create", type: "matter", set: { client: { expr: "error.message" } } }] };
  return out;
};
const POLICY_KINDS = new Set(["create", "update", "upsert", "remove", "stage", "find", "pick", "filter", "fn", "service", "classify", "extract", "call"]);

/** @param {() => number} r @param {any[]} steps */
const flowFrom = (r, steps) => {
  const f = /** @type {any} */ ({ format: 1, name: "t", label: pick(r, ["T", "Refund \"requests\"", "Éclair `flow`", "A, B"]), authorship: pick(r, ["human", "model"]), trigger: pick(r, [{ on: "event", event: "payment.received" }, { on: "manual" }, { on: "time", cron: "0 9 * * 1-5" }, { on: "web", path: "intake-form" }]),
    steps: steps.map(s => (POLICY_KINDS.has(s.kind) ? withPolicy(r, s) : s)) });
  if (r() < 0.5) f.concurrency = 1 + Math.floor(r() * 31);
  if (r() < 0.4) f.lock = validExpr(r, 2);
  if (r() < 0.4) f.stuck_after_ms = 10_000 + Math.floor(r() * 80_000_000);
  if (r() < 0.4) f.description = pick(r, ["Sends the letter.", "Line one\nline two", "Quote \" and backslash \\ and ```fence```"]);
  if (r() < 0.3) f.group = pick(r, ["Intake", "Billing & fees"]);
  if (r() < 0.3) f.sends = { allow: ["alex@example.com"], max: 1 + Math.floor(r() * 50), per_minute: 1 + Math.floor(r() * 10), outside: pick(r, ["ask", "run"]) };
  if (r() < 0.3) f.returns = { n: { expr: validExpr(r, 2) }, plain: pick(r, ["x", 3, true]) };
  if (r() < 0.4) f.on_failure = [{ id: "alert", kind: "create", type: "matter", set: { client: { expr: "error.step" } } }];
  return f;
};

test("generated Flows go through the text form and the lines form and come back the same", { timeout: 240_000 }, async () => {
  const w = await world();
  const built = {};
  for (const [name, sc] of Object.entries(SCENARIOS)) built[name] = (await sc.build(w)).steps;
  const names = Object.keys(built);
  const SEED = 20261016;
  const r = prng(SEED);
  for (let i = 0; i < 160; i++) {
    const name = names[i % names.length];
    const f = flowFrom(r, structuredClone(built[name]));
    const at = `seed ${SEED}, iteration ${i}, scenario ${name}`;
    assert.deepEqual(checkFlow(f), [], `the generator made an invalid Flow (${at})`);
    const text = printFlow(f), back = parseFlowText(text);
    assert.deepEqual(back.problems, [], `the text form did not read back (${at})\n${text}`);
    assert.ok(sameFlow(back.flows[0].flow, f), `the text form changed the Flow (${at})`);
    assert.equal(printFlow(back.flows[0].flow), text, `printing the text form again changed it (${at})`);
    const lines = printLines(f);
    assert.ok(sameFlow(normalizeFlow(parseLines(lines)), f), `the lines form changed the Flow (${at})\n${lines}`);
    assert.equal(printLines(normalizeFlow(parseLines(lines))), lines, `printing the lines again changed them (${at})`);
  }
});

test("generated expressions parse, and an expression written into a Flow keeps its exact text through both forms", () => {
  const SEED = 77;
  const r = prng(SEED);
  for (let i = 0; i < 300; i++) {
    const e = validExpr(r);
    assert.doesNotThrow(() => parse(e), `the generator made an expression the language refuses (seed ${SEED}, iteration ${i}): ${e}`);
    const f = { format: 1, name: "t", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "m", kind: "create", type: "matter", set: { client: { expr: e } } }] };
    const back = parseFlowText(printFlow(f)).flows[0].flow, viaLines = normalizeFlow(parseLines(printLines(f)));
    assert.equal(back.steps[0].set.client.expr, e, `the text form changed the expression (seed ${SEED}, iteration ${i})`);
    assert.equal(viaLines.steps[0].set.client.expr, e, `the lines form changed the expression (seed ${SEED}, iteration ${i})`);
  }
});
