// @ts-check
// threads.turn-asker says whether a person is at the running turn: a chat turn, not a Flow's, a job, a one-off or a run made to act as someone (the vault lets the owner's assistant use the owner's
// items without a grant only then, core/vault/use.js). Fakes only: the Switchboard's turn map and its threads_runs rows.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { registerTurnAsker, attendedRun } from "./turn-asker.js";

test("a chat turn is attended; a Flow, run_as, job or one-off turn is not, whoever asked", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE threads_runs (id TEXT PRIMARY KEY, purpose TEXT, opts TEXT)");
  const add = (/** @type {string} */ id, /** @type {any} */ opts, purpose = null) => db.prepare("INSERT INTO threads_runs (id, purpose, opts) VALUES (?,?,?)").run(id, purpose, JSON.stringify(opts));
  add("chat", { origin: "deck" });
  add("flow", { flow_origin: { flow: "fl_1" } });
  add("runas", { runas: "per_owner1" });
  add("job", {}, "job");
  add("once", { once: true });
  const sb = { db, turnAsker: new Map(["chat", "flow", "runas", "job", "once"].map(id => [id, "per_owner1"])) };
  /** @type {any} */ let def = null;
  registerTurnAsker({ tool: (/** @type {string} */ _n, /** @type {any} */ d) => { def = d; } }, sb);
  const ask = (/** @type {string} */ thread) => def.run({ thread }, { caller: "module:vault" });
  assert.deepEqual(await ask("chat"), { asker: "per_owner1", attended: true });
  for (const id of ["flow", "runas", "job", "once"]) assert.deepEqual(await ask(id), { asker: "per_owner1", attended: false }, id);
  assert.deepEqual(await ask("none"), { asker: null, attended: false });
  assert.equal(attendedRun({ db: { prepare: () => { throw new Error("gone"); } } }, "chat"), false, "a run that cannot be read is not attended");
  await assert.rejects(def.run({ thread: "chat" }, { caller: "module:mail" }), /only the vault and Files/);
});
