// @ts-check
// "Vyre Computer as my default browser" on a REAL vyred: the setting is off, the environment brief every assistant is told says nothing of it; the person turns it on and the brief says Vyre Computer
// is the default browser (G11).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { tempHome, present } from "./helpers.js";

test("the default-browser setting is off, then on: the brief an assistant is told changes with it", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", sessions: { install: false } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (/** @type {string} */ tool, input = {}) => call(tool, input, { root, caller: "cli" });
  assert.equal(d.registry.status().find((/** @type {any} */ m) => m.name === "sessions")?.state, "running", JSON.stringify(d.registry.status().filter((/** @type {any} */ m) => /session/.test(m.name))));
  const brief = async () => { const r = await d.registry.call("sessions.environment", {}, "module:vyred"); return JSON.stringify(r.data || r.error || {}); };
  const got = await cli("settings.get", { key: "computer.default-browser" });
  assert.equal(got.data.value, false, JSON.stringify(got));
  assert.doesNotMatch(await brief(), /default browser/);
  const set = await cli("settings.set", { key: "computer.default-browser", value: true });
  assert.ok(!set.error, JSON.stringify(set));
  assert.equal((await cli("settings.get", { key: "computer.default-browser" })).data.value, true);
  assert.match(await brief(), /Vyre Computer is this person's default browser\. For anything that needs a browser, run tools_call computer\.use first/);
});
