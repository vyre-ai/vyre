import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, run, roots, stepRefs, ExprError } from "./expr.js";

const scope = { trigger: { amount: 250, client: { name: "Harlow Legal" }, tags: ["a", "b"] }, steps: { research: { rows: [{ size: "small" }] } }, stage: "Intake" };

test("expr: comparison, boolean logic, membership and arithmetic", () => {
  assert.equal(run("trigger.amount > 100 and lower(trigger.client.name) contains \"harlow\"", scope), true);
  assert.equal(run("steps.research.rows[0].size in [\"small\", \"medium\"] or stage == \"Closed\"", scope), true);
  assert.equal(run("not (stage == \"Intake\")", scope), false);
  assert.equal(run("1 + 2 * 3 - 4 / 2", scope), 5);
  assert.equal(run("trigger.tags contains \"b\"", scope), true);
  assert.equal(run("\"a\" in \"cat\"", scope), true);
  assert.equal(run("days(2) / hours(1)", scope), 48);
});

test("expr: an absent name or field is null, a comparison on it is false, never an exception", () => {
  assert.equal(run("nothing.at.all", scope), null);
  assert.equal(run("trigger.missing > 1", scope), false);
  assert.equal(run("isnull(trigger.missing)", scope), true);
  assert.equal(run("coalesce(trigger.missing, 7)", scope), 7);
  assert.equal(run("1 / 0", scope), null);
});

test("expr: it reads own properties only, and the dangerous names are refused at parse time", () => {
  for (const bad of ["__proto__", "constructor", "trigger.constructor", "trigger.__proto__.x", "a.prototype"]) assert.throws(() => parse(bad), ExprError, bad);
  assert.equal(run("toString", scope), null);
  assert.equal(run("trigger.hasOwnProperty", scope), null);
});

test("expr: only the fixed functions can be called, and bad input is an error with a position", () => {
  assert.throws(() => parse("eval(\"1\")"), /not a function an expression may call/);
  assert.throws(() => parse("process.exit()"), ExprError);
  assert.throws(() => parse("a +"), /ends too soon/);
  assert.throws(() => parse("\"open"), /not closed/);
  assert.throws(() => parse("a $ b"), /unexpected character/);
  try { parse("a ? b"); assert.fail(); } catch (e) { assert.equal(e.at, 2); }
});

test("expr: limits hold: size, nesting and steps", () => {
  assert.throws(() => parse("1+".repeat(1200) + "1"), /at most/);
  assert.throws(() => parse("(".repeat(60) + "1" + ")".repeat(60)), /nested too deeply/);
  const big = "[" + Array(300).fill("1 + 1").join(",") + "]";
  assert.throws(() => parse(big), /too large/);
  const list = Array.from({ length: 6000 }, (_, i) => i);
  assert.throws(() => run("len(a) + len(b)", { a: list, b: list }) && run(Array(400).join("len(a)+") + "1", { a: list }), ExprError);
});

test("expr: roots and step references drive the compile check", () => {
  const n = parse("steps.find.rows[0].x == trigger.id and item.n > 1");
  assert.deepEqual([...roots(n)].sort(), ["item", "steps", "trigger"]);
  assert.deepEqual([...stepRefs(n)], ["find"]);
});
