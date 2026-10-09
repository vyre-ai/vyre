// @ts-check
// R031-85: what a harness showed it can do at session start is stored per harness, replaced at every start, and read back; nothing is hidden for a harness never seen.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

async function box(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  return { d, internal: (/** @type {string} */ tool, input = {}) => d.registry.call(tool, input, "module:threads"), call: (/** @type {string} */ tool, input = {}) => d.registry.call(tool, input, "cli") };
}

test("sessions.harness: learn stores per harness and replaces at every start; get reads one or all; a harness never seen has no row", async t => {
  const b = await box(t);
  assert.deepEqual((await b.call("sessions.harness.get", {})).data.harnesses, []);
  assert.equal((await b.internal("sessions.harness.learn", { provider: "codex", version: "2.1.0", caps: { skills: null, mcp: false, images: true, "BAD KEY": true, hooks: "yes" }, counts: { tools: 0 }, auth: ["chat-gpt"] })).data.recorded, true);
  assert.equal((await b.internal("sessions.harness.learn", { provider: "claude", version: "2.2.0", caps: { skills: true, subagents: true }, counts: { tools: 40 } })).data.recorded, true);
  const one = (await b.call("sessions.harness.get", { provider: "codex" })).data.harnesses;
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].caps, { skills: null, mcp: false, images: true }, "only true, false or null for a name of letters; the rest is dropped");
  assert.deepEqual(one[0].auth, ["chat-gpt"]);
  await b.internal("sessions.harness.learn", { provider: "codex", version: "2.2.0", caps: { skills: true } });
  const all = (await b.call("sessions.harness.get", {})).data.harnesses;
  assert.deepEqual(all.map((/** @type {any} */ h) => [h.provider, h.version]), [["claude", "2.2.0"], ["codex", "2.2.0"]]);
  assert.deepEqual(all[1].caps, { skills: true }, "replaced, not merged");
  assert.deepEqual((await b.call("sessions.harness.get", { provider: "grok" })).data.harnesses, []);
  assert.equal((await b.call("sessions.harness.learn", { provider: "x", caps: {} })).error !== undefined, true, "internal: a person's surface cannot write it");
});
