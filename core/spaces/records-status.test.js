// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("spaces.records.status answers ready for a store with nothing to wait for, and is the person's own read", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const r = await d.registry.call("spaces.records.status", {}, "cli", { token: (await d.kernel.surfaces.open(chain, {})).token });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.ok(r.data.spaces.length >= 1 && r.data.spaces.every((/** @type {any} */ s) => s.ready === true), JSON.stringify(r.data));
  assert.ok((await d.registry.call("spaces.records.status", {}, "mcp", {})).error, "a model has no chain to read it under");
});

test("recordsStatus says nothing of a Space the caller is not in, and shows a store's own progress words but never a failure's text", async () => {
  const { recordsStatus } = await import("./kernel-members.js");
  const store = (/** @type {boolean} */ up, /** @type {string} */ detail) => ({ attached: () => up, health: async () => ({ ok: up, detail }) });
  const K = { space: "spc_home", spaces: { list: () => ["spc_home", "spc_other", "spc_failed"] }, store: store(true, ""),
    for: (/** @type {string} */ id) => ({ store: id === "spc_other" ? store(false, "starting Records: setting up its workspace (12 s so far)") : id === "spc_failed" ? store(false, "the record store for this space is not available yet: ENOENT /srv/secret/path") : store(true, "") }) };
  assert.deepEqual((await recordsStatus(K, ["spc_home"])).spaces, [{ space: "spc_home", ready: true }], "a member of one sees only that one");
  assert.deepEqual((await recordsStatus(K, [])).spaces, [], "a stranger sees none");
  assert.deepEqual((await recordsStatus(K, ["spc_nowhere"])).spaces, [], "an id that is not on this device is not echoed");
  assert.deepEqual((await recordsStatus(K, ["spc_other", "spc_failed"])).spaces, [
    { space: "spc_other", ready: false, words: "starting Records: setting up its workspace (12 s so far)" },
    { space: "spc_failed", ready: false, words: "the records are not ready yet" }], "progress words pass; a failure's text does not");
});
