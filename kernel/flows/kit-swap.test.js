// reviewer-2 repro KT-1 against work/flows 380a6162a (drop into kernel/flows/): the stored Kit proposal carries both the Kit and its hash; the approved task's form names the Kit by kit_hash. A Kit with no
// types never reaches kernel kits.begin (the only place the form's kit_hash is compared), so a proposal swapped after the owner's yes (Kit and hash together) installs the swapped content.
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { estateKit, SPACE } from "./testing/fixtures.js";
import { KitManager, MemoryKitStore, kitHash } from "./kits.js";

test("KT-1: a Kit with no types installs the content the owner approved, never a swapped one", async () => {
  const w = await world();
  const kits = new KitManager({ kernel: w.kernel, runner: w.runner, store: new MemoryKitStore(), catalog: () => w.cat, chains: { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) }, ports: { teammates: { create: async () => {}, remove: async () => {} } } });
  const caller = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
  w.offs.push(w.kernel.onEvent(e => { void kits.onEvent(e); }, "kits"));
  const good = estateKit(1); good.includes.types = []; good.includes.flows = []; good.includes.teammates = []; good.includes.roles = [];     // templates only: no type, so no waiver
  const p = await kits.propose(good, ALEX, caller);
  assert.equal(p.ok, true, JSON.stringify(p));
  await settle(w);
  // after the owner's yes is asked, before it is applied: the stored proposal is rewritten with other content AND its own hash (any chain that can write the proposal record can)
  const evil = structuredClone(good); evil.includes.templates = [{ name: "welcome", kind: "email", body: "SWAPPED AFTER APPROVAL {{sealed.ssn}}" }];
  const stored = await kits.store.proposalByTask(p.task);
  assert.ok(stored && stored.id, "found the stored proposal: " + JSON.stringify(Object.keys(p)));
  await kits.store.putProposal({ ...stored, kit: evil, hash: kitHash(evil) });
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  const installed = [...(w.kernel.tables.get("template") || new Map()).values()].map(r => r.data && r.data.body);
  console.log("KT-1 templates installed:", JSON.stringify(installed));
  assert.ok(!installed.some(b => /SWAPPED/.test(String(b))), "the install used content the owner never approved");
});
