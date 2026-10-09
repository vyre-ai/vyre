// @ts-check
// R031-00s: repeated work becomes one step. A procedure of Vyre tool calls that ends cleanly in three sessions is offered as a skill that ends in a ready tools_run script. The detector is the learn
// module's own (learn_procs, three clean sessions); this proves the Vyre calls feed it, that the skill is written from evidence with no value from any session, and that nothing else changes.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SKILL_MIGRATIONS, stepsOf, createSkills, template } from "../core/learn/skills.js";
import { skillPrompt } from "../core/learn/jobs.js";
import { isVyreTool, vyreSteps } from "../lib/vyre-steps.js";
import { argsOf } from "../lib/receipt.js";
import { translate } from "../core/switchboard/translate.js";
import { callsOf, runFor, evidenceOf, skeletonOf } from "../lib/skill-skeleton.js";
import { check as checkScript } from "../lib/batch.js";
import { glance } from "../core/assistant/glance.js";
import { tempHome } from "./helpers.js";

test("a Vyre tool call is a step by the tool that really ran, and never carries an argument", () => {
  assert.ok(isVyreTool("mcp__vyre__planner_add") && isVyreTool("mcp__plugin_vyre_vyre__work_call") && !isVyreTool("Bash") && !isVyreTool("mcp__github__list"));
  assert.deepEqual(vyreSteps("mcp__vyre__planner_add", { text: "secret plan" }), ["vyre:planner.add"]);
  assert.deepEqual(vyreSteps("mcp__vyre__tools_call", { tool: "google_mail_search", arguments: { q: "from:dana" } }), ["vyre:google.mail.search"]);
  assert.deepEqual(vyreSteps("mcp__vyre__tools_call", { tool: "google.mail.search" }), ["vyre:google.mail.search"], "dotted and underscored are the same tool");
  assert.deepEqual(vyreSteps("mcp__vyre__work_call", { tool: "clients.find", input: { name: "Whitfield" } }), ["vyre:work.call:clients.find"]);
  assert.deepEqual(vyreSteps("mcp__vyre__tools_run", { steps: [{ id: "a", call: "client.find" }, { id: "b", call: "matter_find" }, { id: "c", fn: "return {}" }] }), ["vyre:client.find", "vyre:matter.find"]);
  for (const finder of ["tools_find", "results_read", "vyre_core"]) assert.deepEqual(vyreSteps(`mcp__vyre__${finder}`, { query: "x" }), [], `${finder} is how a tool is found, not the work`);
  assert.deepEqual(vyreSteps("mcp__vyre__tools_call", { tool: "results_drop" }), []);
  assert.deepEqual(vyreSteps("mcp__vyre__tools_call", { tool: "has spaces; rm -rf" }), [], "an odd name is not kept");
  assert.ok(!JSON.stringify(vyreSteps("mcp__vyre__work_call", { tool: "x", input: { name: "Dana Whitfield" } })).includes("Dana"));
});

test("the arguments of a call are kept as names, and as ids only where an id is what they hold", () => {
  const a = argsOf("mcp__vyre__work_call", { tool: "matters.find", input: { client: "c_17", name: "Dana Whitfield", note: "call her at 555-0100", client_id: "c_17" } });
  assert.deepEqual(a.keys, ["client", "name", "note", "client_id"]);
  assert.deepEqual(a.ids, [{ k: "client_id", v: "c_17" }]);
  assert.ok(!JSON.stringify(a).includes("Whitfield") && !JSON.stringify(a).includes("555"));
  assert.deepEqual(argsOf("mcp__vyre__tools_run", { steps: [{ call: "x", input: { id: "r_1" } }] }), { keys: [], ids: [] });
});

test("the turn's Vyre calls join its Bash and file steps in time order, and a Bash-only turn is as before", () => {
  const steps = stepsOf({ commands: [{ command: "npm test", at: 1 }], tools: [{ steps: ["vyre:client.find"], at: 2 }, { steps: ["vyre:matter.find"], at: 3 }, { steps: ["vyre:planner.add"], at: 4 }] });
  assert.deepEqual(steps, ["npm test", "vyre:client.find", "vyre:matter.find", "vyre:planner.add"]);
  assert.deepEqual(stepsOf({ commands: ["npm test", "git push"] }), stepsOf({ commands: ["npm test", "git push"], tools: [] }));
});

/** One session's Vyre-run thread events for the same four-call job on a client, through the real translate. */
function session(/** @type {string} */ client, /** @type {string} */ cid, /** @type {string} */ mid, /** @type {boolean} */ fail = false) {
  /** @type {any[]} */ const ev = [];
  let i = 0;
  const call = (/** @type {string} */ name, /** @type {any} */ input, /** @type {any} */ result, isError = false) => {
    const id = `tu_${client}_${++i}`;
    const a = translate({ type: "assistant", message: { id: `m${id}`, content: [{ type: "tool_use", id, name, input }] } });
    const u = translate({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(result), is_error: isError }] } });
    ev.push(...a.events, ...u.events);
  };
  call("mcp__vyre__work_call", { tool: "clients.find", input: { name: client } }, { records: [{ id: cid, name: client }] });
  call("mcp__vyre__work_call", { tool: "matters.find", input: { client_id: cid } }, { records: [{ id: mid, title: `Estate of ${client}` }] });
  call("mcp__vyre__tools_call", { tool: "google_mail_search", arguments: { q: `from:${client}` } }, { messages: [{ id: "msg_1" }] });
  call("mcp__vyre__planner_add", { text: `Call ${client} about the estate` }, fail ? "denied: no" : { id: `i_${mid}` }, fail);
  return ev;
}

const STEPS = ["vyre:work.call:clients.find", "vyre:work.call:matters.find", "vyre:google.mail.search", "vyre:planner.add"];

test("three sessions of the same four calls give one evidence block: names and data flow, nothing the person typed", () => {
  const sessions = [session("Dana Whitfield", "c_1", "m_1"), session("Omar Haddad", "c_2", "m_2"), session("Priya Raman", "c_3", "m_3")];
  const runs = sessions.map((e) => runFor(callsOf(e), STEPS));
  assert.ok(runs.every(Boolean));
  const ev = evidenceOf(/** @type {any} */ (runs));
  assert.equal(ev.runs, 3);
  assert.deepEqual(ev.keys[0], ["name"]);
  assert.deepEqual(ev.keys[1], ["client_id"]);
  assert.deepEqual(ev.flows, ["2<-1:id>client_id"], "call 2's client_id was the id call 1 returned, in every run");
  const sk = /** @type {string} */ (skeletonOf(STEPS, ev));
  assert.ok(sk);
  const script = JSON.parse(sk);
  assert.equal(script.steps.length, 4);
  assert.deepEqual(script.steps[0], { id: "s1", call: "work_call", input: { tool: "clients.find", input: { name: "<name>" } } });
  assert.deepEqual(script.steps[1].input.input.client_id, { expr: "steps.s1.<path to the id the earlier call returned>" });
  for (const person of ["Whitfield", "Haddad", "Raman", "c_1", "m_2", "msg_1"]) assert.ok(!sk.includes(person) && !JSON.stringify(ev).includes(person), `${person} never reaches a skill`);
  // the script is one tools_run the checker accepts, once its placeholders are filled and its expr path is written
  const known = (/** @type {string} */ n) => n;
  const filled = JSON.parse(sk.replace(/"<[^"]*>"/g, '"x"').replace(/<path[^>]*>/g, "rows[0].id"));
  assert.deepEqual(checkScript(filled, { known }), []);
});

test("a run with a failed step is not evidence", () => {
  assert.equal(runFor(callsOf(session("Dana Whitfield", "c_1", "m_1", true)), STEPS), null);
});

test("the detector offers the procedure after the third clean session, once, as a skill that ends in the tools_run, and a model's draft keeps that ending", (t) => {
  const db = new DatabaseSync(":memory:");
  for (const sql of SKILL_MIGRATIONS) db.exec(sql);
  const home = tempHome(t);
  const skills = createSkills(db, { now: () => 1_700_000_000_000, emit: () => {}, claudeDir: path.join(home, ".claude") });
  const steps = stepsOf({ tools: STEPS.map((s, i) => ({ steps: [s], at: i })) });
  assert.deepEqual(steps, STEPS);
  for (const [n, s] of ["s1", "s2"].entries()) { skills.record({ session: s, seq: 1, project: null, steps }); skills.mark({ session: s, seq: 1, clean: true }); assert.equal(skills.candidates({ min: 3 }).length, 0, `after ${n + 1} sessions`); }
  skills.record({ session: "s3", seq: 1, project: null, steps }); skills.mark({ session: "s3", seq: 1, clean: true });
  const [cand] = skills.candidates({ min: 3 });
  assert.deepEqual(cand.steps, STEPS);
  const runs = [session("A A", "c_1", "m_1"), session("B B", "c_2", "m_2"), session("C C", "c_3", "m_3")].map((e) => runFor(callsOf(e), STEPS));
  const withEvidence = { ...cand, evidence: evidenceOf(/** @type {any} */ (runs)) };
  const body = template(withEvidence);
  assert.match(body, /Call the Vyre tool `google.mail.search`/);
  assert.match(body, /## One call[\s\S]*```json[\s\S]*"call": "work_call"/);
  assert.match(skillPrompt(withEvidence), /How the 3 runs went[\s\S]*work\.call:clients\.find|vyre:work\.call:clients\.find \(name\)/);
  assert.match(skillPrompt(withEvidence), /Do not write a tools_run script/);
  // a model's own draft is kept, and the one-call section is added to it
  const drafted = skills.propose(withEvidence, { body: "---\nname: learned-estate-intake\ndescription: \"Use when opening an estate\"\n---\n\n1. Look the client up.\n2. Add the todo.\n" });
  assert.match(drafted.body, /1\. Look the client up\./);
  assert.match(drafted.body, /## One call/);
  assert.equal(skills.candidates({ min: 3 }).length, 0, "proposed once, not again");
  // without evidence (a terminal session) the skill is the plain steps, no script
  assert.ok(!/## One call/.test(template(cand)));
});

test("the glance says once that there is something to save, as a count and never a name", async () => {
  const call = async (/** @type {string} */ tool) => (tool === "learn.skills" ? { data: { skills: [{ name: "learned-npm-test-git-push" }, { name: "learned-x" }] } } : { data: tool === "threads.list" ? [] : tool === "waiting.list" ? { rows: [], count: 0 } : {} });
  const g = await glance(call);
  assert.ok(g.lines.some((l) => /2 things Vyre could save as skills/.test(l)));
  assert.ok(!JSON.stringify(g.lines).includes("learned-"));
  const none = await glance(async (tool) => (tool === "learn.skills" ? { data: { skills: [] } } : { data: tool === "threads.list" ? [] : { rows: [], count: 0 } }));
  assert.ok(!none.lines.some((l) => /skill/.test(l)));
});
