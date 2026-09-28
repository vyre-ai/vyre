// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";

// owner.id (team-lead, 28 Sep): made once, on onboard's own startup (core/onboard/index.js),
// never by system.info itself -- this module only reads what onboard already wrote.
test("system: system.info exposes only a fingerprint of owner.id, never the id itself", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ machine: "solo", transcripts: [], network: { onboardPort: 0 } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());

  const r = await d.registry.call("system.info", {}, "cli");
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.match(r.data.owner.fingerprint8, /^[0-9a-f]{8}$/);

  const saved = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.match(saved.owner.id, /^[0-9a-f]{32}$/, "onboard's own startup generated and persisted it");
  assert.equal(r.data.owner.fingerprint8, config.fingerprint8(saved.owner.id), "matches the spec's formula, of the id that was actually saved");

  // The raw id never appears anywhere in the response.
  assert.ok(!JSON.stringify(r.data).includes(saved.owner.id), "owner.id itself never leaves this machine through system.info");
});

test("system: two fresh installs never collide, and each keeps its id across a restart", async t => {
  const root1 = tempHome(t), root2 = tempHome(t);
  for (const root of [root1, root2]) fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ machine: "solo", transcripts: [], network: { onboardPort: 0 } }));
  const d1 = await start({ root: root1, log: () => {} });
  const d2 = await start({ root: root2, log: () => {} });
  t.after(() => d2.stop());
  const [r1, r2] = await Promise.all([d1.registry.call("system.info", {}, "cli"), d2.registry.call("system.info", {}, "cli")]);
  assert.notEqual(r1.data.owner.fingerprint8, r2.data.owner.fingerprint8);

  await d1.stop();
  const d1b = await start({ root: root1, log: () => {} });
  t.after(() => d1b.stop());
  const r1b = await d1b.registry.call("system.info", {}, "cli");
  assert.equal(r1b.data.owner.fingerprint8, r1.data.owner.fingerprint8, "the same id survives a restart, never regenerated");
});
