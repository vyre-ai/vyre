// @ts-check
// A module's view of a Space's gateway (ctx.kernel.for(space).gateway, which the Space door and any first-party module that calls for() use) mints the module's OWN service chain whatever name it asks for: the raw
// gateway's serviceChain(name) would give it any keeper's standing. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Registry } from "./index.js";

test("for(space).gateway.serviceChain(name) is the calling module's own chain, whatever name it asks", () => {
  const raw = { serviceChain: (/** @type {string} */ n) => `chain:${n}`, records: { marker: "records" }, tag: "kept" };
  const home = { space: "spc_home", owner: "per_x", for: (/** @type {string} */ id) => (id === "spc_team" ? { space: id, hosted: true, gateway: raw } : { space: id, hosted: false }) };
  const reg = Object.create(Registry.prototype);
  const attachments = reg.withCrossSpace({ name: "attachments" }, home);
  const gw = attachments.for("spc_team").gateway;
  assert.equal(gw.serviceChain("work"), "chain:attachments", "naming work returns the attachments module's own chain");
  assert.equal(gw.serviceChain("flows"), "chain:attachments", "so does any other name");
  assert.equal(gw.serviceChain(), "chain:attachments");
  assert.equal(gw.tag, "kept", "everything else of the gateway is the same");
  assert.equal(gw.records.marker, "records");
  assert.equal(raw.serviceChain("work"), "chain:work", "the raw gateway is untouched for the kernel's own callers");
  assert.equal(reg.withCrossSpace({ name: "work" }, home).for("spc_team").gateway.serviceChain("anything"), "chain:work", "and work's own view is work's");
  assert.equal(attachments.for("spc_other").hosted, false, "a Space that is not hosted here is returned as it was");
});

test("a module's view of a hosted Space carries no kernel; the registry still routes the module to its own handle there", () => {
  const rawKernel = { gateway: { serviceChain: (/** @type {string} */ n) => `chain:${n}` }, chains: { fromFacts: () => "any chain" }, kernelFor: (/** @type {any} */ m) => ({ chats: `chats-of-${m.name}`, serviceChain: () => `own:${m.name}` }) };
  const home = { space: "spc_home", owner: "per_x", for: (/** @type {string} */ id) => (id === "spc_team" ? { space: id, hosted: true, gateway: rawKernel.gateway, kernel: rawKernel } : { space: id, hosted: false }) };
  const reg = Object.create(Registry.prototype);
  const skills = reg.withCrossSpace({ name: "skills" }, home);
  const view = skills.for("spc_team");
  assert.equal(view.kernel, undefined, "no kernel on the view");
  assert.ok(!("kernel" in view) && !Object.keys(view).includes("kernel") && !Reflect.ownKeys(view).includes("kernel"), "not under any key listing");
  assert.equal(view.gateway.serviceChain("work"), "chain:skills", "and the gateway still gives only the module's own chain");
  assert.equal(view.own.chats, "chats-of-skills", "the module's own handle there is on offer, and is its own");
  assert.equal(reg.withCrossSpace({ name: "stream" }, home).for("spc_team").own.chats, "chats-of-stream");
  // the registry's own routing takes the raw kernel from its private side, so the module is still routed to its handle in the Space the call runs for
  reg.spaceOfCall = () => "spc_team";
  const routed = reg.routedKernel({ name: "skills" }, skills);
  assert.equal(routed.chats, "chats-of-skills", "a call running in the team Space gets the module's handle there");
  assert.equal(routed.kernel, undefined);
});
