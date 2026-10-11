// @ts-check
// A lesson learn drafts from a repeated procedure goes to whoever repeated the work (G24): an agent that did it every time gets the draft at its own level, a project's at the project's, anything else at the
// owner's. A real daemon with the kernel, the draft read back through the library.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";

test("skills.draft.learned drafts at the agent's level when one agent repeated the work, at the project's for a project, else the owner's own", async (t) => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(`${root}/config.json`, JSON.stringify({ vault: { keystore: "file" }, recall: { every: 0, vectors: false } }));
  const d = await start({ root, log: () => {}, presence: present, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const body = (n) => `---\nname: ${n}\ndescription: Use when shipping a change.\n---\n\n1. run the tests\n2. push\n`;
  const draft = (input) => d.registry.call("skills.draft.learned", input, "module:learn");
  const a = await draft({ name: "ship-kit", body: body("ship-kit"), agent: "kit" });
  assert.ok(!a.error, JSON.stringify(a.error));
  const p = await draft({ name: "ship-proj", body: body("ship-proj"), project: "harlow" });
  assert.ok(!p.error, JSON.stringify(p.error));
  const o = await draft({ name: "ship-own", body: body("ship-own") });
  assert.ok(!o.error, JSON.stringify(o.error));
  const level = (r) => (r.data && (r.data.level || (r.data.draft && r.data.draft.level))) || JSON.stringify(r.data).slice(0, 120);
  assert.equal(level(a), "agent", "the agent that repeated it");
  assert.equal(level(p), "project");
  assert.equal(level(o), "personal");
  const bad = await draft({ name: "ship-bad", body: body("ship-bad"), agent: "Not A Slug!" });
  assert.equal(level(bad), "personal", "a name that is not an agent's falls back to the owner's");
});
