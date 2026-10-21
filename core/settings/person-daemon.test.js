// @ts-check
// Per person settings in a real vyred (the kernel on): the owner's own call changes the owner's own row, the theme and a notification switch read back as that person's, and push.settings agrees.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";

test("a person's own change to the theme and to a notification switch is their own row, and push.settings and settings.get agree", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, settings: { claude_dir: path.join(root, "claude") } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, input = {}) => call(tool, input, { root });
  const ok = async (/** @type {string} */ tool, input = {}) => { const r = await c(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  assert.equal((await ok("settings.get", { key: "appearance.scheme" })).value, "system");
  assert.equal((await ok("settings.set", { key: "appearance.scheme", value: "dark", level: "account" })).value, "dark");
  assert.equal((await ok("settings.get", { key: "appearance.scheme" })).value, "dark");
  assert.equal((await ok("settings.schema")).keys.find((/** @type {any} */ k) => k.key === "appearance.scheme").perPerson, true);
  assert.equal((await ok("push.settings")).kinds.watch, true);
  await ok("settings.set", { key: "push.watch", value: false });
  assert.equal((await ok("settings.get", { key: "push.watch" })).value, false);
  assert.equal((await ok("push.settings")).kinds.watch, false);
  await ok("push.settings", { kinds: { draft: false } });
  assert.equal((await ok("settings.get", { key: "push.draft" })).value, false);
  assert.equal((await ok("push.settings")).kinds.draft, false);
  assert.equal((await ok("push.settings")).kinds.ask, true, "the others are as they were");
});
