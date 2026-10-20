// @ts-check
// Each person's own model pick in a chat (picks.js): one person's pick never changes another's turns or the chat itself; a turn runs on its asker's pick; a turn by someone with no pick runs on the chat's
// own model; a pick is only ever on the picker's own AI account; and the switch shows as one quiet line naming the model by its real name. A fake Switchboard over an in-memory store.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pickChat, pickOver, pickOf } from "./picks.js";

const OWNER = "per_" + "o".repeat(26), BOB = "per_" + "b".repeat(26), ANA = "per_" + "a".repeat(26), EVE = "per_" + "e".repeat(26);

function world() {
  const db = new DatabaseSync(":memory:");
  /** @type {Record<string, any>} */ const runs = { t1: { id: "t1", provider: "claude", account: null, model: "lab-deep-2", project: null, agent: null } };
  /** @type {Record<string, any[]>} */ const accounts = {
    [BOB]: [{ id: "acct_bob", provider: "codex", person: BOB }],
    [ANA]: [{ id: "acct_ana", provider: "claude", person: ANA }],
    [OWNER]: [],
  };
  /** @type {any[]} */ const emitted = [];
  /** @type {string[]} */ const setModels = [];
  const sb = {
    db, canon: (/** @type {string} */ p) => p,
    deps: {
      providers: new Map([["codex", {}], ["openrouter", {}]]), owner: () => OWNER,
      call: async (/** @type {string} */ tool, /** @type {any} */ i) => (tool === "models.list" ? { data: { models: i.provider === "codex" ? [{ id: "gpt-5.3-codex", name: "GPT-5.3-Codex", context: 400000 }] : [{ id: "lab-fast-1", name: "Lab Fast 1" }, { id: "lab-deep-2", name: "Lab Deep 2" }] } } : { data: null }),
    },
    must: (/** @type {string} */ id) => runs[id], record: (/** @type {string} */ id) => runs[id] || null,
    accountFor: async (/** @type {any} */ q) => {
      const mine = accounts[q.person] || [];
      const a = mine.find((x) => x.provider === q.provider && (!q.account || x.id === q.account));
      if (q.account && !a) throw Object.assign(new Error(`no account ${q.account}`), { code: "not_found" });
      return a || null;
    },
    emit: (/** @type {string} */ type, /** @type {any} */ payload, /** @type {string} */ thread) => emitted.push({ type, payload, thread }),
    switchModel: async (/** @type {string} */ id, /** @type {string} */ m) => { runs[id].model = m; setModels.push(m); },
    switchEffort: async (/** @type {string} */ id, /** @type {string} */ e) => { runs[id].effort = e; },
  };
  return { sb, runs, emitted, setModels, db };
}

test("one person's pick is theirs: the chat and everyone else's turns stay as they were, and the switch is one quiet line with the model's real name", async () => {
  const w = world();
  const r = await pickChat(w.sb, { thread: "t1", person: BOB, provider: "codex", model: "gpt-5.3-codex", effort: "high" });
  assert.deepEqual(r, { thread: "t1", provider: "codex", model: "gpt-5.3-codex", name: "GPT-5.3-Codex", account: "acct_bob", effort: "high", mine: true });
  assert.deepEqual([w.runs.t1.provider, w.runs.t1.model], ["claude", "lab-deep-2"], "picking stops, starts and switches nothing");
  assert.deepEqual(w.emitted.map((e) => [e.type, e.payload.text, e.payload.notice]), [["thread.text", `{person:${BOB}} switched to GPT-5.3-Codex`, true]]);
  // Bob's turn runs on his pick: the one-turn hop onto his own account, with his model and effort
  assert.deepEqual(await pickOver(w.sb, "t1", { asker: BOB }, null), { provider: "codex", account: "acct_bob", person: BOB, model: "gpt-5.3-codex", effort: "high" });
  // the owner picked nothing: their turn runs on the chat's own model, on the thread's own account
  assert.equal(await pickOver(w.sb, "t1", { asker: OWNER }, null), null);
  assert.deepEqual([w.runs.t1.provider, w.runs.t1.model], ["claude", "lab-deep-2"]);
  assert.deepEqual(pickOf(w.db, "t1", OWNER), null, "nothing was stored for the owner");
});

test("a pick on the chat's own provider sets the model for its picker's turns only, and the next person's turn goes back to the chat's own model", async () => {
  const w = world();
  // the owner, with no account row of their own, picks another model of the chat's own provider (the machine's sign-in)
  const mine = await pickChat(w.sb, { thread: "t1", person: OWNER, provider: "claude", model: "lab-fast-1" });
  assert.equal(mine.name, "Lab Fast 1");
  assert.equal(await pickOver(w.sb, "t1", { asker: OWNER }, null), null);
  assert.equal(w.runs.t1.model, "lab-fast-1", "the owner's turn runs on the owner's pick");
  assert.equal(await pickOver(w.sb, "t1", { asker: EVE }, null), null);
  assert.equal(w.runs.t1.model, "lab-deep-2", "Eve picked nothing: her turn runs on the chat's own model, not on the owner's pick");
  assert.deepEqual(w.setModels, ["lab-fast-1", "lab-deep-2"]);
  // Ana's own Claude account: her turn is hers (askerOver's answer) with her model
  await pickChat(w.sb, { thread: "t1", person: ANA, provider: "claude", model: "lab-fast-1", account: "acct_ana" });
  const own = { provider: "claude", account: "acct_ana", person: ANA };
  assert.deepEqual(await pickOver(w.sb, "t1", { asker: ANA }, own), { ...own, model: "lab-fast-1" });
});

test("a pick is only ever on the picker's own AI account, and a person with none is told how to connect one", async () => {
  const w = world();
  await assert.rejects(() => pickChat(w.sb, { thread: "t1", person: BOB, provider: "claude", model: "lab-fast-1", account: "acct_ana" }), (e) => /** @type {any} */ (e).code === "account_required", "Bob cannot pick on Ana's account");
  await assert.rejects(() => pickChat(w.sb, { thread: "t1", person: EVE, provider: "codex", model: "gpt-5.3-codex" }), (e) => /Connect your own AI account in Settings, AI accounts/.test(/** @type {any} */ (e).message));
  await assert.rejects(() => pickChat(w.sb, { thread: "t1", person: BOB, provider: "codex", model: "bad model; rm" }), (e) => /** @type {any} */ (e).code === "bad_input");
  await assert.rejects(() => pickChat(w.sb, { thread: "t1", person: null, provider: "codex", model: "gpt-5.3-codex" }), (e) => /** @type {any} */ (e).code === "denied");
  assert.equal(w.emitted.length, 0, "a refused pick says nothing in the chat");
});
