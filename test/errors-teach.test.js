// @ts-check
// R031-00r errors that teach: every refusal says what to do next. A refusal written in the code as a literal message (refuse("...", "denied") and the like) must name a real tool, say who decides,
// or give an instruction, so a caller is never left to guess. A dotted name in a message must be a tool that exists (a stale hint is worse than none). None is tolerated: it is a preflight guard. bad_input is left out: its message names the field and what it must be.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hasNextStep, nextCall, refusalsIn } from "../lib/errors-teach.js";
import { sourceFiles, ROOT } from "./source-files.js";
import { broadCatalog } from "./tools-universe.js";

const TOOLS = new Set(broadCatalog().map((c) => c.tool));
/** The codes a caller meets as a refusal it must act on. */
const REFUSALS = /^(denied|forbidden|not_allowed|refused|not_found|unavailable|not_available|no_[a-z_]+|conflict|exists|unsupported|timeout|too_large|unreachable|rate_limited|busy|needs_[a-z_]+)$/;
const IN_SCOPE = /^(core|lib|harness|local|modules|records|stores)\//;

/** @returns {{ at: string, file: string, code: string, message: string, unknown: string[] }[]} */
function findings() {
  /** @type {any[]} */ const out = [];
  for (const f of sourceFiles()) {
    if (!IN_SCOPE.test(f)) continue;
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const r of refusalsIn(text)) {
      if (!REFUSALS.test(r.code) || r.message.replace(/x/g, "").trim().length < 4) continue;
      const v = hasNextStep(r.message, TOOLS);
      if (!v.ok || v.unknown.length) out.push({ at: `${f}:${text.slice(0, r.index).split("\n").length}`, file: f, code: r.code, message: r.message, unknown: v.unknown });
    }
  }
  return out;
}

test("the check itself: a tool, a person who decides, an instruction or a need is a next step; a bare statement is not", () => {
  const t = new Set(["flows.list", "work.team.add"]);
  assert.equal(hasNextStep("no such Flow (flows.list shows them)", t).ok, true);
  assert.equal(hasNextStep("only the owner may do this", t).ok, true);
  assert.equal(hasNextStep("ask the person to pair a phone first", t).ok, true);
  assert.equal(hasNextStep("pair a phone first", t).ok, true);
  assert.equal(hasNextStep("no such project", t).ok, false);
  assert.equal(hasNextStep("not found", t).ok, false);
  assert.deepEqual(hasNextStep("see flows.nothing for that", t).unknown, ["flows.nothing"], "a dotted name that is no tool is a stale hint");
  assert.equal(hasNextStep("see flows.nothing for that", t).ok, true, "but the words around it still instruct");
  assert.deepEqual(hasNextStep("open example.com or notes.md", t).unknown, [], "a host or a file is not a tool name");
});

test("the refusals in the code are found as literals, with template parts blanked", () => {
  const src = 'throw refuse("no such project", "not_found");\nthrow Object.assign(new Error(`no ${kind} here`), { code: "denied" });\nrefuse(someVariable, "denied");';
  assert.deepEqual(refusalsIn(src).map((r) => [r.code, r.message]), [["not_found", "no such project"], ["denied", "no x here"]]);
});

test("ready calls for the tools a message names, by the name the agent calls them, listed ones directly", () => {
  const cat = [{ name: "flows_list", tool: "flows.list", input: { type: "object" } }, { name: "work_team_add", tool: "work.team.add", input: { type: "object", required: ["role"], properties: { role: { type: "string" } } } }];
  assert.deepEqual(nextCall("no such Flow (flows.list shows them)", cat), ['tools_call { tool: "flows_list", arguments: {} }']);
  assert.deepEqual(nextCall("use work.team.add or flows.list", cat, { listed: new Set(["flows_list"]) }), ['tools_call { tool: "work_team_add", arguments: {"role":"<role>"} }', "flows_list {}"]);
  assert.deepEqual(nextCall("no tool named nothing.here", cat), []);
  assert.deepEqual(nextCall("flows.list flows.list work.team.add flows.list", cat, { max: 2 }).length, 2);
});

/** None is tolerated (a preflight guard): a refusal without a next step fails the branch that adds it. */
const GRACE = 0;

test("no refusal without a next step, and no stale tool name in a message (a few in flight are tolerated)", () => {
  const found = findings();
  const show = found.slice(0, 12).map((f) => `${f.at} ${f.code}: "${f.message}"${f.unknown.length ? ` (not a tool: ${f.unknown.join(", ")})` : ""}`);
  console.log(`refusals without a next step: ${found.length}`);
  assert.ok(found.length <= GRACE, `say what to do next in these refusals: name the tool that lists or fixes it, who decides, or what to supply.\n  ${show.join("\n  ")}`);
});
