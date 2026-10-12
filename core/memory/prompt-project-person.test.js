// @ts-check
// memory.prompt gives a project's memory to a person's thread only if THAT person may use the project (the Space's owner or an admin, or the project's owner or team: work.project.may-read). Otherwise the
// prompt is built as for a chat with no project. The question and the answer are asked of the work module here by a fake; the real answer is core/work's (core/work/chat-project-filing.test.js covers its rule).
// (fictional data only)
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import memory from "./index.js";

const W = `${HOME}/Work`;
const T0 = Date.parse("2026-08-01T09:00:00Z");
const WORLD = [{ id: "88888888-dddd-4000-8000-000000000001", cwd: `${W}/harlow-site`, start: T0, turns: [{ role: "user", text: "host the harlow site on netlify for now, free tier is fine" }] }];

async function rig(/** @type {any} */ t, /** @type {(input: any) => boolean | "error"} */ may) {
  const db = open(path.join(tempHome(t), "vyre.db")); t.after(() => db.close());
  seedRecall(db, WORLD);
  const tools = new Map(), asked = /** @type {any[]} */ ([]);
  const ctx = { name: "memory", config: { me: { domains: ["riverastudio.com"] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {}, events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      if (tool === "work.project.may-read") { asked.push(input); const v = may(input); return v === "error" ? { error: { code: "failed", message: "work is down" } } : { data: { ok: v } }; }
      return tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : fakeReachCall(tool, input, { agents: [], projects: [] });
    }, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), iqRunner: null, memoryRunner: null };
  const handle = await memory.start(/** @type {any} */ (ctx)); t.after(() => handle.stop());
  await tools.get("memory.curate").run({}, { caller: "cli" });
  await tools.get("memory.remember").run({ text: "The harlow-site decision: host the site on netlify" }, { caller: "cli" });
  const prompt = (/** @type {any} */ extra) => tools.get("memory.prompt").run({ prompt: "where do we host the harlow site", first: true, thread: "t1", person: true, project: "harlow-site", project_cwds: [`${W}/harlow-site`], ...extra }, { caller: "module:switchboard", firstParty: true }).then((/** @type {any} */ r) => r.text);
  return { prompt, asked };
}

test("memory.prompt: a person's thread gets the project's room only if she may use the project; no answer counts as no", async t => {
  const MEMBER = "per_" + "m".repeat(26), OWNER = "per_" + "o".repeat(26);
  const { prompt, asked } = await rig(t, i => (i.person === OWNER ? true : i.person === "per_" + "e".repeat(26) ? "error" : false));
  const none = await prompt({ project: undefined, project_cwds: undefined, for_person: MEMBER });
  const owner = await prompt({ for_person: OWNER });
  assert.match(owner, /netlify/, "control: the owner's thread in the project gets its memory");
  const member = await prompt({ for_person: MEMBER });
  assert.ok(!/netlify|harlow/i.test(member), "a member who is not on the project gets none of its memory: " + member.slice(0, 160));
  assert.equal(member, none, "her prompt is the one a chat with no project gets");
  assert.ok(!/netlify|harlow/i.test(await prompt({ for_person: "per_" + "e".repeat(26) })), "when work cannot answer, the room is left out");
  assert.deepEqual(asked.map(a => [a.project, a.person]).slice(0, 2), [["harlow-site", OWNER], ["harlow-site", MEMBER]], "the question names the thread's project and its person");
  // a caller that names no person (the owner's own terminal) is as before: nothing is asked
  const before = asked.length;
  assert.match(await prompt({}), /netlify/, "no for_person: unchanged");
  assert.equal(asked.length, before, "and work is not asked");
});
