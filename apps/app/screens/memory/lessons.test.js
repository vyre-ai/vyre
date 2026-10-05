// @ts-check
// Lessons against a fake box: tool names and inputs, grouping, verdicts, refusals.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

const LESSONS = [
  { id: 1, rule: "Never push to main", level: "block", status: "active", scope: "all", check: { kind: "tool" }, applied: 14, caught: 3, broken: 1, source: { kind: "denied" } },
  { id: 2, rule: "Ask before sending email", level: "ask", status: "proposed", scope: { project: "harlow" } },
  { id: 3, rule: "Old rule", level: "remind", status: "retired" },
  { id: 4, rule: "Dormant one", level: "remind", status: "dormant" },
];

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "learn.lessons") return { data: o.lessons ?? { lessons: LESSONS } };
    if (tool === "learn.stats") return o.stats ?? { data: [{ id: 1, verdict: "working", before: 4, after: 1.26 }] };
    if (tool === "learn.skills") return o.skills ?? { data: { skills: [{ id: 9, name: "release-notes", status: "proposed", steps: [1, 2, 3, 4], sessions: 3 }, { id: 8, status: "installed" }] } };
    if (o.refuse && o.refuse === tool) return { error: { code: "presence_required", message: "Needs you." } };
    return { data: {} };
  };
  return { call, seen };
}

test("load: lessons, stats and skills in one read; skills absent is null, not an error", { skip: !strip }, async () => {
  const { lessonsSource } = await import("./lessons-source.ts");
  const b = box();
  const d = await lessonsSource(b.call).load();
  assert.equal(d.lessons.length, 4);
  assert.deepEqual(b.seen.map((s) => s.tool).sort(), ["learn.lessons", "learn.skills", "learn.stats"]);
  assert.deepEqual(b.seen.find((s) => s.tool === "learn.lessons")?.input, { status: "all" });
  const none = await lessonsSource(box({ skills: { error: { code: "no_such_tool", message: "x" } } }).call).load();
  assert.equal(none.skills, null);
  const bare = await lessonsSource(box({ lessons: [LESSONS[0]] }).call).load();
  assert.equal(bare.lessons.length, 1);
});

test("a lessons error is thrown with its code", { skip: !strip }, async () => {
  const { lessonsSource } = await import("./lessons-source.ts");
  await assert.rejects(lessonsSource(async () => ({ error: { code: "no_such_tool", message: "gone" } })).load(), (e) => /** @type {any} */ (e).code === "no_such_tool");
});

test("acts: tool names and inputs", { skip: !strip }, async () => {
  const { lessonsSource } = await import("./lessons-source.ts");
  const b = box();
  const s = lessonsSource(b.call);
  await s.accept(2); await s.retire(2); await s.relax(1, "ask"); await s.edit(1, { rule: "Never push to main or master" }); await s.skillInstall(9); await s.skillDismiss(9);
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [
    ["learn.accept", { id: 2 }], ["learn.retire", { id: 2 }], ["learn.relax", { id: 1, level: "ask" }],
    ["learn.edit", { id: 1, rule: "Never push to main or master" }], ["learn.skill-install", { id: 9 }], ["learn.skill_retire", { id: 9 }]]);
});

test("a refused act keeps its code so the screen can say it needs the person", { skip: !strip }, async () => {
  const { lessonsSource } = await import("./lessons-source.ts");
  const { refusalWords } = await import("./lessons-model.ts");
  await assert.rejects(lessonsSource(box({ refuse: "learn.accept" }).call).accept(2), (e) => {
    assert.equal(/** @type {any} */ (e).code, "presence_required");
    assert.equal(refusalWords(/** @type {any} */ (e), "learn.accept"), "Needs you.");
    return true;
  });
  assert.match(refusalWords({ code: "no_such_tool" }, "learn.relax"), /newer learning module \(learn\.relax/);
});

test("grouping: proposed, active (dormant counts), retired", { skip: !strip }, async () => {
  const { groupLessons } = await import("./lessons-model.ts");
  const g = groupLessons(LESSONS);
  assert.deepEqual([g.proposed.length, g.active.map((l) => l.id), g.retired.length], [1, [1, 4], 1]);
});

test("words: scope, counts, check, source, relax levels", { skip: !strip }, async () => {
  const { scopeWords, countsLine, checkWords, lowerLevels, SOURCE, skillLine } = await import("./lessons-model.ts");
  assert.equal(scopeWords("all"), "Everywhere");
  assert.equal(scopeWords({ project: "harlow" }, new Map([["harlow", "Harlow Legal"]])), "Only in Harlow Legal");
  assert.equal(scopeWords({ agent: "kit" }), "Only for kit");
  assert.equal(countsLine(LESSONS[0]), "applied 14, caught 3, broken 1");
  assert.equal(countsLine(LESSONS[1]), "applied 0, caught 0, broken 0");
  assert.equal(checkWords({ kind: "tool" }), "tool check");
  assert.equal(checkWords({}), "check");
  assert.equal(checkWords(null), null);
  assert.deepEqual(lowerLevels("block"), ["remind", "ask"]);
  assert.deepEqual(lowerLevels("remind"), []);
  assert.equal(SOURCE.denied, "a call you denied");
  assert.equal(skillLine({ id: 1, steps: [1], sessions: 2 }), "1 step, seen clean in 2 sessions");
});

test("verdicts from each shape learn.stats answers in", { skip: !strip }, async () => {
  const { verdictOf } = await import("./lessons-model.ts");
  assert.deepEqual(verdictOf([{ id: 1, verdict: "working", before: 4, after: 1.26 }], 1), { verdict: "working", text: "Working, 4 to 1.3 per 100 turns" });
  assert.equal(verdictOf({ lessons: [{ lesson: 2, effect: "not_working" }] }, 2)?.text, "Not working");
  assert.equal(verdictOf({ 3: { verdict: "measuring", turns: 12 } }, 3)?.text, "Measuring, 12 turns so far");
  assert.equal(verdictOf(null, 1), null);
  assert.equal(verdictOf([], 1), null);
});

test("edit refusals: a loosening says it needs Relax", { skip: !strip }, async () => {
  const { editRefusal } = await import("./lessons-model.ts");
  assert.match(editRefusal({ code: "presence_required", message: "No." }), /needs Relax, which needs you in person/);
  assert.match(editRefusal({ code: "x", message: "an edit may not relax a lesson" }), /needs Relax/);
  assert.equal(editRefusal({ code: "x", message: "Bad rule." }), "Bad rule.");
});
