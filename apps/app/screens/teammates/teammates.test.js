// @ts-check
// Teammates (the Deck's project-team.js, ported): the rows as drawn, the Assign to list, and every call over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const ROWS = [
  { agent: "t1", project: "dana", role: "design", brief: "UI work", filler: { kind: "agent", agent: "kit" }, state: "working", queued: 2, current_request: "r1", last_result: { request: "r0", state: "done", result: "Shipped\n the   mock" } },
  { agent: "t2", project: "dana", role: "backend", filler: { kind: "default" }, state: "idle", queued: 0, last_result: { state: "failed", result: "x".repeat(300) } },
  { agent: 5, role: "bad" }, null,
];

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); const f = o[tool]; return f ? (typeof f === "function" ? f(input) : f) : { data: {} }; };
  return { call, seen };
}

test("teammates: rows keep what is drawn and say the state in words", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const rows = m.teammatesOf(ROWS);
  assert.deepEqual(rows.map((r) => r.agent), ["t1", "t2"]);
  assert.deepEqual(rows.map((r) => m.stateWord(r.state)), ["Working", "Idle"]);
  assert.equal(m.stateWord("odd"), "odd");
  assert.equal(m.fillLine(rows[0]), "kit fills it · 2 queued");
  assert.equal(m.fillLine(rows[1]), "The project's helper");
  assert.equal(m.rowLine(rows[0]), "Last: Shipped the mock");
  assert.ok(m.rowLine(rows[1]).startsWith("Failed: ") && m.rowLine(rows[1]).length <= 168, "a long result is clipped");
  assert.deepEqual(m.teammatesOf(null), []);
  assert.equal(m.plural(1, "teammate"), "1 teammate");
});

test("teammates: a role is one lowercase word and a project is named to the box by its record id", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.ok(m.ROLE.test("design") && m.ROLE.test("back-end"));
  for (const bad of ["Design", "two words", "", "1x", "a".repeat(40)]) assert.equal(m.ROLE.test(bad), false, bad);
  assert.equal(m.projectId({ id: "01JABC" }), "01JABC");
  assert.equal(m.projectId({ id: " 01JABC ", data: { name: "No slug here" } }), "01JABC", "a project with no slug still has a team: the id is the key");
  assert.equal(m.projectId({ data: { slug: "dana-wine" } }), "", "a slug is not an id");
  assert.equal(m.projectId(null), "");
  assert.equal(m.projectTitle("01JABC", { "01JABC": "Dana Wine intake" }), "Dana Wine intake");
  assert.equal(m.projectTitle("01JZZZ", {}), "A project", "never the raw id");
  assert.equal(m.projectTitle("", {}), "Everywhere");
});

test("assign to: people and agents together, the project's teammates first, services never", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const actors = [
    { id: "a1", name: "juno", family: "agent" }, { id: "p1", name: "Sam Park", family: "person" }, { id: "p2", name: "Alex Chen", family: "person" },
    { id: "s1", name: "mailer", family: "service" }, { id: "a2", name: "kit", family: "agent" },
  ];
  const g = m.assignGroups(actors, ["a1", "p1"], []);
  assert.deepEqual(g.map((x) => x.title), ["On this project", "Everyone"]);
  assert.deepEqual(g[0].rows.map((a) => a.id), ["p1", "a1"], "people before agents inside a group");
  assert.deepEqual(g[1].rows.map((a) => a.id), ["p2", "a2"]);
  assert.equal(m.assignGroups(actors, [], ["p1"]).flatMap((x) => x.rows).some((a) => a.id === "p1" || a.id === "s1"), false, "excluded and service rows are left out");
  assert.deepEqual(m.assignGroups(actors, [], []).map((x) => x.title), ["People and assistants"]);
  assert.deepEqual(m.searchGroups(g, "ALEX").flatMap((x) => x.rows.map((a) => a.id)), ["p2"]);
  assert.deepEqual(m.searchGroups(g, "zzz"), []);
});

test("teammates: grouped by project for the Assistants page", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const rows = m.teammatesOf([{ agent: "a", project: "zed", role: "x" }, { agent: "b", project: "", role: "y" }, { agent: "c", project: "dana", role: "z" }, { agent: "d", project: "dana", role: "a" }]);
  const g = m.byProject(rows);
  assert.deepEqual(g.map((x) => x.project), ["dana", "zed", ""]);
  assert.deepEqual(g[0].rows.map((r) => r.role), ["a", "z"]);
});

test("teammates: the source calls the box's own tools with the inputs the Deck sent", { skip: !strip }, async () => {
  const { teammatesSource } = await import("./source.ts");
  const b = box({
    "team.list": { data: ROWS }, "work.project.ref": { data: { id: "P1", urn: "vyre://s/project/P1", slug: "dana", name: "Dana Wine intake" } }, "team.default.get": { data: { enabled: false } },
    "team.notes": { data: { text: "n" } }, "team.charter.get": { data: { charter: { text: "c" } } },
    "team.duties.list": { data: { duties: [{ id: "d1", title: "T", instruction: "watch", trigger: "daily", act: false, enabled: true, started: true }, { nope: 1 }] } },
    "team.status": { data: { state: "running", position: 0 } },
    "agents.list": { data: [{ name: "kit", kind: "agent" }, { name: "me", kind: "assistant" }] },
  });
  const s = teammatesSource(b.call);
  assert.equal((await s.list("P1")).length, 2);
  assert.deepEqual(b.seen.at(-1), { tool: "team.list", input: { project: "P1" } });
  assert.deepEqual(await s.names(["P1", "P1", ""]), { P1: "Dana Wine intake" });
  assert.deepEqual(b.seen.at(-1), { tool: "work.project.ref", input: { project: "P1" } });
  await s.all(); assert.deepEqual(b.seen.at(-1).input, { all: true });
  assert.equal(await s.steer("P1"), false);
  const t = (await s.list("P1"))[0];
  const p = await s.pane(t);
  assert.deepEqual({ n: p.notes, c: p.charter, st: p.status, e: p.errors, d: p.duties.map((d) => d.id) }, { n: "n", c: "c", st: { state: "running", position: 0 }, e: 0, d: ["d1"] });
  assert.deepEqual(await s.fillers(), ["kit"], "the person's own assistant never fills a role");
  await s.add("P1", "design", "  UI  "); assert.deepEqual(b.seen.at(-1), { tool: "team.add", input: { project: "P1", role: "design", brief: "UI" } });
  await s.add("P1", "qa"); assert.deepEqual(b.seen.at(-1).input, { project: "P1", role: "qa" });
  await s.retire("t1"); assert.deepEqual(b.seen.at(-1), { tool: "team.retire", input: { teammate: "t1" } });
  await s.setNotes("t1", "hi"); assert.deepEqual(b.seen.at(-1).input, { action: "set", agent: "t1", text: "hi" });
  await s.setCharter("t1", "c2"); assert.deepEqual(b.seen.at(-1), { tool: "team.charter.set", input: { teammate: "t1", text: "c2" } });
  await s.fill("t1", "kit"); assert.deepEqual(b.seen.at(-1).input, { teammate: "t1", agent: "kit" });
  await s.fill("t1"); assert.deepEqual(b.seen.at(-1).input, { teammate: "t1" });
  const d = p.duties[0];
  await s.dutyOn(d); assert.deepEqual(b.seen.at(-1), { tool: "team.duties.enable", input: { id: "d1", expect: "watch" } });
  await s.dutyOff(d); assert.deepEqual(b.seen.at(-1), { tool: "team.duties.disable", input: { id: "d1" } });
  await s.dutyRun(d); assert.deepEqual(b.seen.at(-1).tool, "team.duties.run-now");
  await s.setSteer("P1", true); assert.deepEqual(b.seen.at(-1), { tool: "team.default.set", input: { project: "P1", enabled: true } });
});

test("teammates: a refusal throws with the box's words, and an unreadable pane part is counted", { skip: !strip }, async () => {
  const { teammatesSource } = await import("./source.ts");
  const { errWords } = await import("./model.ts");
  const s = teammatesSource(box({ "team.list": { error: { code: "not_found", message: "no such tool" } }, "team.notes": { error: { code: "x", message: "" } } }).call);
  await assert.rejects(s.list("P1"), (e) => errWords(e) === "Teammates are not available on your server yet.");
  const p = await s.pane({ agent: "t", project: "d", role: "r", brief: "", filler: null, state: "idle", queued: 0, current: null, last: null });
  assert.equal(p.notes, null); assert.equal(p.errors, 1 + 0 + 0, "only the notes read failed");
});

test("the team's roster (a template's roles) is shown beside the teammates, and not twice", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  const { teammatesSource } = await import("./source.ts");
  assert.deepEqual(m.membersOf({ members: [{ agent: "research", role: "researcher" }, { agent: "", role: "x" }, { role: "y" }] }), [{ agent: "research", role: "researcher" }]);
  assert.deepEqual(m.membersOf(undefined), []);
  const team = m.teammatesOf(ROWS);
  const members = [{ agent: "kit", role: "designer" }, { agent: "research", role: "researcher" }, { agent: "t1", role: "design" }];
  assert.deepEqual(m.rosterOnly(team, members), [{ agent: "research", role: "researcher" }], "an agent that already fills a teammate, or is one, is not listed again");
  const seen = [];
  const call = async (tool, input) => { seen.push([tool, input]); return tool === "work.project.members" ? { data: { members: [{ agent: "research", role: "researcher" }] } } : { data: [] }; };
  assert.deepEqual(await teammatesSource(call).members("p1"), [{ agent: "research", role: "researcher" }]);
  assert.deepEqual(seen, [["work.project.members", { project: "p1" }]]);
  assert.deepEqual(await teammatesSource(async () => ({ error: { code: "unknown_tool", message: "no such tool" } })).members("p1"), [], "a box that cannot say shows nothing extra");
});
