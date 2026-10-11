// @ts-check
// An agent's folder is judged on its real path, and the tool runs on that path: a `..` or a symlink into another project
// is refused, and what gets through is the canonical folder (cwdArg, core/modules/index.js + projects.of).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, kernelCaller } from "../../test/helpers.js";

async function world(/** @type {any} */ t) {
  const root = fs.realpathSync(tempHome(t));
  const north = path.join(root, "work", "northwind"), harlow = path.join(root, "work", "harlow");
  fs.mkdirSync(path.join(north, "src"), { recursive: true });
  fs.mkdirSync(path.join(harlow, "secrets"), { recursive: true });
  fs.symlinkSync(harlow, path.join(north, "link-to-harlow"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] }, projectsDir: path.join(root, "projects") }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const reg = d.registry;
  await reg.call("projects.create", { name: "Northwind", home: north }, "cli");
  await reg.call("projects.create", { name: "Harlow", home: harlow }, "cli");
  // kit is a real agent, granted northwind only: a kernel grant made in the person's own call
  const made = await kernelCaller(d, root)("agents.create", { name: "kit", projects: ["northwind"] });
  assert.equal(made.error, undefined, JSON.stringify(made));
  return { reg, north, harlow };
}

test("cwdArg: an agent's folder is judged on its real path: a `..` or a symlink into another project is refused, and what runs is the canonical folder", async t => {
  const { reg, north, harlow } = await world(t);
  const as = cwd => reg.call("projects.of", { cwd }, "mcp:agent:kit");
  const own = await as(path.join(north, "src"));
  assert.equal(own.data && own.data.slug, "northwind", JSON.stringify(own));
  assert.equal(own.data.folder, path.join(north, "src"), "the canonical folder comes back");
  assert.equal((await as(path.join(north, "src", "..", "..", "harlow"))).error.code, "not_found", "a .. path into another project");
  assert.equal((await as(path.join(north, "link-to-harlow"))).error.code, "not_found", "a symlink inside northwind into harlow");
  assert.equal((await as(path.join(north, "link-to-harlow", "secrets"))).error.code, "not_found", "and under it");
  assert.equal((await as(path.join(harlow, "secrets"))).error.code, "not_found", "the other project directly");
  assert.equal((await as(path.join(north, "src") + path.sep)).data.slug, "northwind", "a trailing slash is the same folder");
  assert.equal((await reg.call("projects.of", { cwd: path.join(harlow, "secrets") }, "cli")).data.slug, "harlow", "the person is unaffected");
});
