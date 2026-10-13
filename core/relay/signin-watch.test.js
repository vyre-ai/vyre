// @ts-check
// Serving a name's sign-in requests must never turn the relay on: a watch only listens when the relay is already on.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { createRelay } from "../../relay/node/server.js";
import { tempHome } from "../../test/helpers.js";
import { macCore } from "../../test/fake-core-keys.js";

const LOC = "a".repeat(43);
async function home(/** @type {any} */ t, /** @type {boolean} */ enabled) {
  const relay = createRelay();
  const url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  return { d, root };
}

test("relay.signin.watch with the relay off leaves it off and says it is not watching", async t => {
  const { d, root } = await home(t, false);
  const r = await d.registry.call("relay.signin.watch", { loc: LOC }, "module:wink");
  assert.deepEqual(r.data, { watching: false, supported: false }, JSON.stringify(r));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).relay.enabled, false, "the config still says off");
  assert.equal((await d.registry.call("relay.status", {}, "cli", { proof: { method: "passkey", id: "x" } })).data?.enabled ?? false, false);
});

test("with the relay on, relay.signin.watch watches", async t => {
  const { d } = await home(t, true);
  const r = await d.registry.call("relay.signin.watch", { loc: LOC }, "module:wink");
  assert.equal(r.data?.watching, true, JSON.stringify(r));
});
