// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PKG_ROOT } from "../../kernel/devbuild.js";
import mod, { parseMap } from "./index.js";

const page = fs.readFileSync(path.join(PKG_ROOT, "docs", "architecture", "map.md"), "utf8");

test("the map's module table is read into rows with their group", () => {
  const rows = parseMap(page);
  assert.ok(rows.length > 60, `${rows.length} rows`);
  const gate = rows.find((r) => r.name === "gate");
  assert.ok(gate && gate.folder === "core/gate/" && gate.group.length > 0 && gate.does.length > 10);
});

test("vyre.core joins the map with what runs now, and narrows by query or module", async () => {
  /** @type {any} */ let run;
  const ctx = { paths: { root: "/nonexistent" }, tool: (/** @type {string} */ _n, /** @type {any} */ d) => { run = d.run; }, modules: { status: () => [{ name: "gate", state: "running", version: "0.1.0" }, { name: "zzz-added", state: "failed" }] } };
  await mod.start(ctx);
  const all = await run({});
  assert.equal(all.total, all.modules.length);
  const gate = all.modules.find((/** @type {any} */ m) => m.name === "gate");
  assert.equal(gate.state, "running");
  assert.equal(all.modules.find((/** @type {any} */ m) => m.name === "zzz-added").state, "failed");
  assert.ok(all.modules.find((/** @type {any} */ m) => m.name === "vault").state === "not here");
  assert.deepEqual((await run({ module: "gate" })).modules.map((/** @type {any} */ m) => m.name), ["gate"]);
  const q = await run({ query: "relay" });
  assert.ok(q.modules.length >= 1 && q.modules.every((/** @type {any} */ m) => /relay/i.test(`${m.name} ${m.does}`)));
});
