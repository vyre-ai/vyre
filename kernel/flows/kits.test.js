import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { estateKit, SPACE } from "./testing/fixtures.js";
import { KitManager, MemoryKitStore, installCard, diffKits, checkKit, kitParts, kitHash } from "./kits.js";

const mine = (w, type) => [...(w.kernel.tables.get(type) || new Map()).values()];

async function kitWorld() {
  const w = await world();
  w.cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  const created = [];
  const kits = new KitManager({ kernel: w.kernel, runner: w.runner, store: new MemoryKitStore(), catalog: () => w.cat, chains: { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) }, clock: () => w.clock.t, installerRole: () => "admin",
    ports: { teammates: { create: async (c, t) => created.push(t), remove: async (c, n) => { const i = created.findIndex(x => x.name === n); if (i >= 0) created.splice(i, 1); } } } });
  const caller = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
  w.offs.push(w.kernel.onEvent(e => { void kits.onEvent(e); }, "kits"));
  // removing a Kit is an admin act: a person's own chain (the real kernel does not give it to an automation's)
  const person = w.kernel.as ? w.kernel.as(ALEX) : caller;
  return { w, kits, caller, person, created };
}

test("kits: the card says everything the Kit adds, and what could surprise", async () => {
  const w = await world();
  w.cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  const card = installCard(estateKit(2), w.cat);
  assert.equal(card.ok, true, JSON.stringify(card.errors));
  assert.deepEqual(card.adds.types.map(t => [t.name, t.fields, t.sealed]), [["estate-matter", 4, ["ssn"]]]);
  assert.deepEqual(card.adds.types[0].stages[0].tasks.map(t => [t.title, t.doer, t.checker, t.output]), [["Research the client", "teammate:research", null, "fields"], ["Welcome email", "teammate:intake", "role:attorney", "sent"]]);
  assert.deepEqual(card.adds.templates[0].slots, ["ssn"]);
  assert.equal(card.adds.teammates[0].trust, "external");
  assert.equal(card.adds.flows.length, 2);
  assert.ok(card.adds.flows.find(f => f.name === "weekly_digest").outward.length === 1);
  assert.ok(card.notes.some(n => /send or publish/.test(n)) && card.notes.some(n => /Sealed fields/.test(n)) && card.notes.some(n => /outside text/.test(n)));
  assert.equal(card.trust, "external");
});

test("kits: a Kit whose Flow names a missing type, or whose role exceeds the installer's, is refused with reasons", async () => {
  const { w, kits, caller } = await kitWorld();
  const bad = estateKit(1); bad.includes.flows[0].steps[0].type = "ghost";
  assert.equal(checkKit(bad, w.cat).ok, false);
  const r = await kits.propose(bad, ALEX, caller);
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /no record type ghost/);
  const greedy = estateKit(1); greedy.includes.roles[0].abilities = ["space.delete"];
  kits.roleOf = () => "manager";
  const g = await kits.propose(greedy, ALEX, caller);
  assert.equal(g.ok, false);
  assert.match(g.errors[0].message, /would hold space.delete, which the person installing does not hold/);
});

test("kits: installing makes a card and a task, changes nothing until a person approves, then adds every part", async () => {
  const { w, kits, caller, created } = await kitWorld();
  const p = await kits.propose(estateKit(1), ALEX, caller);
  assert.equal(p.ok, true);
  await settle(w);
  const task = w.kernel.tasks.find(t => t.id === p.task);
  assert.equal(task.source, "manual", "a task a Kit makes is a plain asked task: the kernel keeps its own sources for itself");
  assert.equal(task.form.kind, "kit_install");
  assert.deepEqual([task.doer.id, task.checker.id], ["flows", "per_alex"], "the Flows service asks, the approver checks");
  assert.equal(task.form.card.kit.id, "estate-planning");
  assert.equal(w.kernel.tables.get("estate-matter"), undefined, "nothing was defined yet");
  assert.equal((await w.runner.listRuns()).length, 0);
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  assert.ok(w.kernel.defines.some(d => (d.add_types || []).some(t => t.name === "estate-matter")));
  assert.equal(mine(w, "template").length, 1);
  assert.equal(mine(w, "def-role").length, 1);
  assert.deepEqual(created.map(t => t.name), ["research", "intake"]);
  assert.equal((await kits.list())[0].status, "installed");
  // the Kit's Flow is live: a payment makes an estate matter
  w.kernel.inbound("payment.received", { client: "Kit client" });
  await settle(w);
  assert.equal(mine(w, "estate-matter")[0].data.client, "Kit client");
  // the same version cannot be installed twice
  const again = await kits.propose(estateKit(1), ALEX, caller);
  assert.equal(again.ok, false);
  assert.match(again.errors[0].message, /already installed/);
});

test("kits: a declined card installs nothing", async () => {
  const { w, kits, caller } = await kitWorld();
  const p = await kits.propose(estateKit(1), ALEX, caller);
  w.kernel.completeTask(p.task, { outcome: "rejected" });
  await settle(w);
  assert.equal(mine(w, "template").length, 0);
  assert.equal((await kits.list()).length, 0);
});

test("kits: an update shows the diff with every widening named, and applies new versions while old runs finish on theirs", async () => {
  const { w, kits, caller } = await kitWorld();
  const p1 = await kits.propose(estateKit(1), ALEX, caller);
  w.kernel.completeTask(p1.task, { outcome: "approved" });
  await settle(w); await settle(w);
  const p2 = await kits.propose(estateKit(2), ALEX, caller);
  assert.equal(p2.ok, true, JSON.stringify(p2.errors));
  assert.equal(p2.diff.widening, true);
  const what = p2.diff.widenings.map(x => x.what);
  assert.ok(what.some(x => /may now email.send on/.test(x)), "the new Flow's caps");
  assert.ok(what.some(x => /now email.send to/.test(x) || /now email.send/.test(x)));
  assert.ok(what.some(x => /merges the sealed field ssn/.test(x)));
  assert.ok(what.some(x => /now holds kits.use/.test(x)));
  assert.ok(what.some(x => /starting instructions changed/.test(x)));
  assert.deepEqual(p2.diff.added.map(a => a.name), ["weekly_digest"]);
  assert.ok(p2.diff.changed.find(c => c.name === "welcome"));
  w.kernel.completeTask(p2.task, { outcome: "approved" });
  await settle(w); await settle(w);
  const row = (await kits.store.get("estate-planning"));
  assert.equal(row.version, 2);
  assert.equal(Object.keys(row.flows).length, 2);
  assert.equal(mine(w, "template")[0].data.body.includes("{{sealed.ssn}}"), true, "the template was updated in place");
  assert.equal(mine(w, "template").length, 1);
});

test("kits: an update that drops a part removes it, and names the removals and field changes as risks", () => {
  const w = { cat: { space: SPACE, types: {}, actions: { "email.send": { risk: "outward.send" } }, roles: [], teammates: [], templates: [] } };
  const v1 = estateKit(2), v2 = estateKit(1);
  v2.includes.types[0].fields = v2.includes.types[0].fields.filter(f => f.name !== "email").map(f => (f.name === "client" ? { ...f, kind: "rich_text" } : f));
  const d = diffKits(v1, v2, w.cat);
  assert.deepEqual(d.removed.map(r => r.name), ["weekly_digest"]);
  assert.ok(d.risks.some(r => /email is removed/.test(r.what)));
  assert.ok(d.risks.some(r => /client changes kind/.test(r.what)));
});

test("kits: removing a Kit stops its Flows, deletes its definitions, keeps types that hold data, and never deletes data", async () => {
  const { w, kits, caller, person, created } = await kitWorld();
  const p = await kits.propose(estateKit(1), ALEX, caller);
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await settle(w);
  w.kernel.inbound("payment.received", { client: "Keeps" });
  await settle(w);
  assert.equal(mine(w, "estate-matter").length, 1);
  const flowId = Object.values((await kits.store.get("estate-planning")).flows)[0];
  const r = await kits.remove("estate-planning", ALEX, person);
  assert.deepEqual(r.types_kept, ["estate-matter"]);
  assert.match(r.note, /Kept estate-matter: they still hold records/);
  assert.equal((await w.store.flowRow(flowId)).status, "disabled");
  await w.kernel.idle?.();
  assert.equal(mine(w, "template").filter(t => !t.deleted_at).length, 0);
  assert.deepEqual(created, []);
  assert.equal(mine(w, "estate-matter").length, 1, "the matter is still there");
  w.kernel.inbound("payment.received", { client: "After" });
  await settle(w);
  assert.equal(mine(w, "estate-matter").length, 1, "the stopped Flow does nothing");
  assert.equal((await kits.list())[0].status, "removed");
  // an empty type is removed with the Kit
  const second = await kitWorld();
  const p2 = await second.kits.propose(estateKit(1), ALEX, second.caller);
  second.w.kernel.completeTask(p2.task, { outcome: "approved" });
  await settle(second.w); await settle(second.w);
  const r2 = await second.kits.remove("estate-planning", ALEX, second.person);
  assert.deepEqual(r2.types_removed, ["estate-matter"]);
  await second.w.kernel.idle?.();
  assert.equal(second.w.kernel.tables.get("estate-matter"), undefined);
});

test("kits: removing needs the right to, and a Kit that is not installed is not found", async () => {
  const { w, kits, caller } = await kitWorld();
  await assert.rejects(() => kits.remove("nothing", ALEX, caller), /not installed/);
  const p = await kits.propose(estateKit(1), ALEX, caller);
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await settle(w);
  w.kernel.rules.push({ match: i => i.action === "kits.remove", effect: "ask", reason: "needs_approval" });
  await assert.rejects(() => kits.remove("estate-planning", ALEX, caller), /needs a person's yes/);
  assert.equal(kitParts(estateKit(1)).length, 6);
});

test("kits: the installed Kits and waiting proposals are records, so they survive a restart on the real kernel", async () => {
  const w = await world();
  const { RecordsKitStore } = await import("./kits.js");
  const sys = w.kernel.sysChain();
  const store = new RecordsKitStore({ kernel: w.kernel, chain: sys });
  await store.define();
  const mk = s => new KitManager({ kernel: w.kernel, runner: w.runner, store: s, catalog: () => w.cat, chains: { forFlow: x => w.kernel.chainFor(x), forDoer: () => w.kernel.moduleChain({ module: "flows", approver: ALEX }) }, clock: () => w.clock.t, installerRole: () => "admin",
    ports: { teammates: { create: async () => {}, remove: async () => {} } } });
  const kits = mk(store);
  const caller = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
  w.offs.push(w.kernel.onEvent(e => { void kits.onEvent(e); }, "kits-records"));
  const p = await kits.propose(estateKit(1), ALEX, caller);
  assert.equal(p.ok, true);
  // a restart: a new manager on a new store object over the same kernel finds the proposal and the approval installs it
  const after = mk(new RecordsKitStore({ kernel: w.kernel, chain: sys }));
  assert.equal((await after.store.proposalByTask(p.task)).kit.id, "estate-planning");
  await w.kernel.completeTask(p.task, { outcome: "approved" });
  await after.onEvent({ type: "task.completed", subject: `vyre://${SPACE}/task/${p.task}`, data: {} });
  const listed = await new RecordsKitStore({ kernel: w.kernel, chain: sys }).list();
  assert.deepEqual(listed.map(r => [r.kit_id, r.status]), [["estate-planning", "installed"]]);
  assert.equal(await after.store.proposalByTask(p.task), null, "the proposal is gone once it is installed");
});

test("a type-less Kit is checked against the approved kit_hash too: swapping the stored Kit and its stored hash after the card was shown installs nothing", async () => {
  const { w, kits, caller } = await kitWorld();
  const plain = n => ({ format: 1, id: "plain-kit", version: 1, name: "Plain", description: "Templates only.", includes: { templates: Array.from({ length: n }, (_, i) => ({ name: `note${i}`, kind: "email", body: `Hello ${i}` })) } });
  const shown = plain(1), swapped = plain(2);
  const p = await kits.propose(shown, ALEX, caller);
  assert.equal(p.ok, true, JSON.stringify(p));
  await settle(w);
  // the stored proposal record holds the Kit and its hash side by side: an attacker who can write it replaces both
  const stored = await kits.store.getProposal(p.proposal);
  await kits.store.putProposal({ ...stored, kit: swapped, hash: kitHash(swapped) });
  w.kernel.completeTask(p.task, { outcome: "approved" });
  await settle(w); await new Promise(r => setImmediate(r)); await settle(w);
  assert.equal(mine(w, "template").length, 0, "nothing was installed from a Kit the owner never saw");
  assert.ok(!(await kits.list()).some(k => k.kit_id === "plain-kit" && k.status === "installed"));
});

test("the install card shows every part the hash covers: each part is named or counted, role abilities are listed, and changing any one part changes the hash", async () => {
  const w = await world();
  w.cat.actions["email.send"] = { risk: "outward.send", label: "Send an email" };
  const kit = estateKit(2);
  const card = installCard(kit, w.cat);
  assert.equal(card.ok, true, JSON.stringify(card.errors));
  const parts = kitParts(kit);
  const named = new Set([...card.adds.types.map(t => `type:${t.name}`), ...card.adds.templates.map(t => `template:${t.name}`), ...card.adds.roles.map(r => `role:${r.name}`), ...card.adds.teammates.map(t => `teammate:${t.name}`),
    ...card.adds.flows.map(f => `flow:${f.name}`), ...card.adds.views.map(v => `view:${v}`)]);
  for (const p of parts.filter(x => x.kind !== "seed")) assert.ok(named.has(`${p.kind}:${p.name}`), `the card names ${p.kind} ${p.name}`);
  assert.equal(card.adds.seed, parts.filter(x => x.kind === "seed").length);
  // what a role GRANTS is on the card, not just its name
  for (const r of parts.filter(x => x.kind === "role")) assert.deepEqual(card.adds.roles.find(x => x.name === r.name).abilities, r.def.abilities || []);
  // the hash covers each part: change one thing in each kind of part and the card's hash moves
  const base = card.kit.hash;
  const bump = (/** @type {(k: any) => void} */ f) => { const k = structuredClone(kit); f(k); return installCard(k, w.cat).kit.hash; };
  assert.notEqual(bump(k => { k.includes.templates[0].body += " x"; }), base, "a template body");
  assert.notEqual(bump(k => { k.includes.roles[0].abilities = [...(k.includes.roles[0].abilities || []), "kits.use"]; }), base, "a role's abilities");
  assert.notEqual(bump(k => { k.includes.teammates[0].instructions += " x"; }), base, "a teammate's instructions");
  assert.notEqual(bump(k => { k.includes.flows[0].steps = [...k.includes.flows[0].steps]; k.includes.flows[0].label = "Changed"; }), base, "a Flow");
  assert.notEqual(bump(k => { k.includes.types[0].label = "Changed"; }), base, "a type");
});
