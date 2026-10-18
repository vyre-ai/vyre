// @ts-check
// agents: an agent's fallback model is kept, listed and checked; sessions.accounts.models lists what an account offers. Temp home only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("fallback_model is saved by agents.create and agents.update, cleared by an empty value, and checked", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "local");
  const find = async (/** @type {string} */ n) => (await c("agents.list")).data.find((/** @type {any} */ a) => a.name === n);
  const made = await c("agents.create", { name: "kit", kind: "agent", projects: [], model: "opus", fallback_model: "sonnet" });
  assert.equal(made.error, undefined, JSON.stringify(made));
  assert.deepEqual([(await find("kit")).model, (await find("kit")).fallback_model], ["opus", "sonnet"]);
  await c("agents.update", { name: "kit", instructions: "Bake the Northwind Bakery report" });
  assert.equal((await find("kit")).fallback_model, "sonnet");
  assert.equal((await c("agents.update", { name: "kit", fallback_model: "haiku" })).error, undefined);
  assert.equal((await find("kit")).fallback_model, "haiku");
  assert.equal((await c("agents.update", { name: "kit", fallback_model: "" })).error, undefined);
  assert.ok(!(await find("kit")).fallback_model);
  assert.equal((await c("agents.update", { name: "kit", fallback_model: "not a model!" })).error.code, "bad_input");
});

test("sessions.accounts.models lists the models of an account's provider, and refuses an account that is not there", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "local");
  const accts = await c("sessions.accounts.list", {});
  assert.equal(accts.error, undefined, JSON.stringify(accts));
  const first = (accts.data.accounts || accts.data)[0];
  if (first) {
    const r = await c("sessions.accounts.models", { account: first.id });
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.data.account, first.id);
    assert.ok(Array.isArray(r.data.models));
  }
  assert.equal((await c("sessions.accounts.models", { account: "nope" })).error.code, "not_found");
});
