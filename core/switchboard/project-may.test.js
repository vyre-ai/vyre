// @ts-check
// Whose rights decide what project a thread may use (core/switchboard/asker-account.js projectPerson, projectMay): the verified asker of the turn; with none (a plain resume, a hop back, a restart) the person the
// thread was started for; with no person at all (the owner's own terminal) nobody is asked. Work not answering counts as no.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectPerson, projectMay, NOBODY } from "./asker-account.js";

const OWNER = "per_" + "o".repeat(26), ANA = "per_" + "a".repeat(26);
const sb = (/** @type {Map<string, string>} */ asker, /** @type {(i: any) => any} */ answer) => { const asked = /** @type {any[]} */ ([]); return { asked, turnAsker: asker, deps: { call: async (/** @type {string} */ tool, /** @type {any} */ i) => { asked.push([tool, i]); return answer(i); } } }; };
const rec = { id: "t1", project: "owners-matter" };

test("projectPerson: the verified asker; else the person the thread was started for; else nobody", () => {
  assert.equal(projectPerson(sb(new Map([["t1", ANA]]), () => ({})), rec, { person: OWNER }), ANA, "a verified asker wins");
  assert.equal(projectPerson(sb(new Map(), () => ({})), rec, { person: OWNER }), OWNER, "no verified asker: the starter, not the placeholder");
  assert.equal(projectPerson(sb(new Map(), () => ({})), rec, {}), undefined, "no person at all: the owner's own terminal");
  assert.notEqual(NOBODY, OWNER);
});

test("projectMay: an owner's resumed project chat keeps its project; a member who was started on it is judged by work; no answer is no; the owner's terminal asks nobody", async () => {
  const may = (/** @type {any} */ i) => ({ data: { ok: i.person === OWNER } });
  const s = sb(new Map(), may);
  assert.equal(await projectMay(s, rec, { person: OWNER }), true, "the owner's resumed chat (no verified asker) keeps the project");
  assert.deepEqual(s.asked[0], ["work.project.may-read", { project: "owners-matter", person: OWNER }], "and work was asked about the starter");
  assert.equal(await projectMay(sb(new Map(), may), rec, { person: ANA }), false, "a member's resumed chat, judged by her stored person: work says no");
  assert.equal(await projectMay(sb(new Map(), () => ({ error: { code: "failed" } })), rec, { person: OWNER }), false, "work cannot answer: no");
  const none = sb(new Map(), may);
  assert.equal(await projectMay(none, rec, {}), true, "no person at all: open");
  assert.deepEqual(none.asked, [], "and work is not asked");
  assert.equal(await projectMay(sb(new Map(), may), { id: "t2" }, { person: ANA }), true, "no project: nothing to ask");
});
