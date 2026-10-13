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

test("after a reboot: the relay is on, its link is not up at boot, it connects a few seconds later, and the sign-in watch then starts", async t => {
  const { signinLoc } = await import("../../relay/client/signin.js");
  const { nodeCrypto } = await import("../../relay/client/nodecrypto.js");
  // a port nothing listens on yet: the box is enabled and cannot reach its relay at boot
  const probe = createRelay();
  const url = await probe.listen();
  const port = Number(new URL(url.replace(/^ws/, "http")).port);
  await probe.close();
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ root, log: () => {}, coreKeys: macCore() });
  t.after(() => d.stop());
  /** @type {any[]} */ const seen = [];
  d.events.on("*", (/** @type {any} */ e) => seen.push([e.type, e.payload]));
  d.registry.tools.set("spaces.identity.self", { module: "spaces", description: "", input: { type: "object" }, internal: false, callers: null, hook: false, presence: false, run: async () => ({ id: "ident-kit", name: "kit" }) });
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!seen.some(e => e[0] === "relay.connected"), "the link is not up yet");
  // the relay comes up; the box's link retries and connects
  const relay = createRelay();
  await relay.listen(port);
  t.after(() => relay.close());
  const until = async (/** @type {() => any} */ f, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 100)); } };
  await until(() => seen.some(e => e[0] === "relay.connected"));
  // a typed name now reaches the box and opens the sign-in ticket
  const loc = await signinLoc("kit", nodeCrypto());
  const post = () => fetch(`${url.replace(/^ws/, "http")}/v1/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc, s: "k".repeat(22) }) });
  await until(async () => { await post(); return seen.some(e => e[0] === "wink.signin-asked"); }, 8000).catch(() => { throw new Error("the sign-in watch never started after the relay connected"); });
});
