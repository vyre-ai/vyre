import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CONTACT } from "../../kernel/conformance/suite.js";

test("records.*: a signed-in device creates and queries records in its Space under its own chain; a guest, a model and a call with no person are refused; another Space is not reachable", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const ok = async (tool, input, caller = "cli") => { const r = await call(tool, input, { root, caller }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  // the owner's own surface: define a type, make and read a record
  const noProof = await call("records.define", { diff: { add_types: [CONTACT] } }, { root, caller: "cli" });
  assert.ok(!noProof.error, "one rule (7bf5dd47a): the owner's own surface is the person, so changing the types needs no presence: " + JSON.stringify(noProof));
  // with the stand-in file present the same call still goes through; the one rule never asks the stand-in, so nothing is logged as one
  const fsx = await import("node:fs"), pathx = await import("node:path");
  fsx.writeFileSync(pathx.join(root, "dev-presence-stand-in"), "");
  const viaStandIn = await call("records.define", { diff: { add_types: [CONTACT] } }, { root, caller: "cli" });
  assert.ok(!viaStandIn.error, JSON.stringify(viaStandIn));
  fsx.rmSync(pathx.join(root, "dev-presence-stand-in"));
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [CONTACT] }).catch(() => {});
  const types = await ok("records.types", {});
  assert.ok(JSON.stringify(types).includes("contact"));
  assert.ok(types.types.every(t => !t.system && !/^(def-|flow-|kit-)/.test(t.name) && t.name !== "goal"), "the kernel's own types are left out by default: " + types.types.map(t => t.name));
  assert.ok((await ok("records.types", { system: true })).types.some(t => t.system === true), "and flagged when asked for");
  const all = (await ok("records.types", { system: true })).types;
  for (const n of ["kit-install", "kit-proposal", "def-role", "def-view"]) { const t = all.find(x => x.name === n); if (t) assert.equal(t.system, true, `${n} is a system type`); }
  // a type may say it is a project (the app lists Projects by that, no names hard-coded); the store keeps it and records.types returns it
  await d.kernel.gateway.records.define(ownerChain, { add_types: [{ name: "matter", label: "Matter", kind: "project", fields: [{ name: "title", kind: "text", label: "Title" }] }] });
  assert.equal((await ok("records.types", {})).types.find(t => t.name === "matter").kind, "project");
  const made = (await ok("records.create", { type: "contact", data: { name: "Jane", age: 40 } })).record;
  assert.equal(made.data.name, "Jane");
  const page = await ok("records.list", { type: "contact", limit: 10 });
  assert.equal(page.rows.length, 1);
  const got = (await ok("records.get", { urn: made.urn })).record;
  assert.equal(got.data.name, "Jane");
  // #contact: the same record put in front of the AI, with the reference as a tool; a bad urn is refused like records.get
  const refd = (await ok("records.reference", { urn: made.urn })).reference;
  assert.equal(refd.title, "Jane");
  assert.ok(refd.text.includes("Name: Jane") && Array.isArray(refd.placeholders));
  assert.equal((await call("records.reference", { urn: "nonsense" }, { root, caller: "cli" })).error.code, "bad_input");
  const upd = (await ok("records.update", { urn: made.urn, patch: { age: 41 }, base_version: got.version })).record;
  assert.equal(upd.data.age, 41);
  const stale = await call("records.update", { urn: made.urn, patch: { age: 42 }, base_version: got.version }, { root, caller: "cli" });
  assert.equal(stale.error && stale.error.code, "version_conflict");
  assert.equal((await ok("records.me", {})).person, d.kernel.id.owner);
  assert.ok((await ok("records.actors", {})).actors.some(a => a.id === d.kernel.id.owner));
  // refused: models, guests, anonymous, a module
  for (const caller of ["mcp", "mcp:agent:kit", "guest:x", "anonymous"]) {
    const r = await call("records.list", { type: "contact" }, { root, caller });
    assert.ok(r.error, `${caller}: ${JSON.stringify(r)}`);
  }
  // not a record reference, and a Space that is not here
  assert.equal((await call("records.get", { urn: "nonsense" }, { root, caller: "cli" })).error.code, "bad_input");
  assert.equal((await call("records.list", { type: "contact", space: "spc_zzzzzzzzzzzz" }, { root, caller: "cli" })).error.code, "not_found");
  // sealed values: the person seals a value in, the record keeps a reference, an assistant sees a placeholder, a reveal needs the person's presence, the feed shows what happened
  const sealed = await call("records.seal-put", { urn: made.urn, field: "ssn", value: "123-45-6789", class: "us-ssn" }, { root, caller: "cli" });
  assert.ok(!sealed.error, JSON.stringify(sealed));
  const ref = sealed.data.record.data.ssn;
  assert.ok(ref && ref.ref && ref.sealed, "the record holds only a reference");
  assert.ok(!JSON.stringify(sealed).includes("123-45-6789"), "the plaintext is nowhere in the answer");
  const asPerson = (await ok("records.sees-as", { urn: made.urn, who: "person" })).data;
  assert.ok(asPerson.ssn && asPerson.ssn.present === true);
  const asAssistant = (await ok("records.sees-as", { urn: made.urn, who: "assistant" })).data;
  assert.equal(asAssistant.ssn && asAssistant.ssn.ref, undefined, "an assistant sees a placeholder, never the reference");
  const noProofReveal = await call("records.reveal", { urn: made.urn, field: "ssn", purpose: "check" }, { root, caller: "cli" });
  assert.ok(noProofReveal.error && !JSON.stringify(noProofReveal).includes("123-45-6789"), JSON.stringify(noProofReveal));
  assert.equal((await call("records.seal-put", { urn: made.urn, field: "name", value: "x" }, { root, caller: "cli" })).error.code, "bad_input", "not a sealed field");
  const feed = (await ok("records.events", { record: made.urn })).events;
  assert.ok(feed.length >= 2 && feed.every(e => e.subject.startsWith(made.urn)), "the record's own events");
  assert.ok(feed.some(e => e.type === "contact.created"));
  // a second Space this home hosts: the same device acts there under THAT Space's own chain, and a stranger's Space is not reachable
  const second = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "second" });
  const ownerIn2 = second.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await second.gateway.records.define(ownerIn2, { add_types: [CONTACT] });
  const in2 = (await ok("records.create", { space: second.space, type: "contact", data: { name: "Other", age: 7 } })).record;
  assert.ok(in2.urn.startsWith(`vyre://${second.space}/`), in2.urn);
  assert.equal((await ok("records.list", { space: second.space, type: "contact" })).rows.length, 1, "its own Space's records");
  assert.equal((await ok("records.list", { type: "contact" })).rows.length, 1, "the home's Space holds only its own");
  assert.equal((await ok("records.workspace.create", { space: second.space }, "module:first-party").catch(() => ({ workspaceId: second.space }))).workspaceId, second.space);
  // the spaces module's step
  assert.deepEqual(await ok("records.workspace.create", { space: d.kernel.id.space }, "module:first-party").catch(() => null), null, "a person's surface cannot call the internal step");
});

test("records.dev-seed: refused unless the presence stand-in is on; with it, the walk's types, records and tasks appear, one task waiting for the person and a sealed value that is only a reference", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const off = await call("records.dev-seed", {}, { root, caller: "cli" });
  assert.equal(off.error && off.error.code, "dev_only");
  const fsx = await import("node:fs"), pathx = await import("node:path");
  fsx.writeFileSync(pathx.join(root, "dev-presence-stand-in"), "");
  const r = await call("records.dev-seed", {}, { root, caller: "cli" });
  assert.ok(!r.error, JSON.stringify(r));
  assert.equal(r.data.contacts.length, 3);
  assert.equal(r.data.matters.length, 4);
  const types = (await call("records.types", {}, { root, caller: "cli" })).data.types;
  assert.equal(types.find(x => x.name === "matter").kind, "project");
  const contacts = (await call("records.list", { type: "contact" }, { root, caller: "cli" })).data.rows;
  assert.ok(contacts.some(c => c.data.ssn && c.data.ssn.ref), "one sealed value, kept as a reference");
  const tasks = (await call("tasks.list", {}, { root, caller: "cli" })).data.tasks;
  assert.deepEqual(tasks.map(x => x.state).sort(), ["needs_check", "working"], JSON.stringify(tasks.map(x => [x.title, x.state])));
  assert.equal(tasks.find(x => x.state === "needs_check").checker.id, d.kernel.id.owner, "waiting for the person");
  // a second run adds only what is missing: nothing
  const again = await call("records.dev-seed", {}, { root, caller: "cli" });
  assert.ok(!again.error, JSON.stringify(again));
  assert.equal((await call("records.list", { type: "contact" }, { root, caller: "cli" })).data.rows.length, 3);
  assert.equal((await call("records.list", { type: "matter" }, { root, caller: "cli" })).data.rows.length, 4);
  assert.equal((await call("tasks.list", {}, { root, caller: "cli" })).data.tasks.length, 2);
});

test("records.linked and records.kits.*: the reverse of a link under the caller's chain, and the Kit library with a Kit a person can take to the install card", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const ok = async (tool, input, caller = "cli") => { const r = await call(tool, input, { root, caller }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [CONTACT, { name: "matter", label: "Matter", kind: "project", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "client", kind: "link", to: "contact", label: "Client" }] }] });
  const jane = (await ok("records.create", { type: "contact", data: { name: "Jane" } })).record;
  const m = (await ok("records.create", { type: "matter", data: { title: "Doe estate plan", client: { urn: jane.urn } } })).record;
  const got = await ok("records.linked", { urn: jane.urn });
  assert.deepEqual(got.rows.map(x => [x.type, x.field, x.record.id]), [["matter", "client", m.id]]);
  assert.equal(got.truncated, false);
  assert.equal((await ok("records.linked", { urn: jane.urn, type: "contact" })).rows.length, 0);
  assert.equal((await call("records.linked", { urn: "nonsense" }, { root, caller: "cli" })).error.code, "bad_input");
  for (const caller of ["mcp", "guest:x", "anonymous"]) assert.ok((await call("records.linked", { urn: jane.urn }, { root, caller })).error, `${caller} is refused`);
  const lib = (await ok("records.kits.library", {})).kits;
  const estate = lib.find(k => k.id === "estate-planning");
  assert.ok(estate && estate.adds.types.includes("matter") && estate.adds.sealed_fields.includes("contact.ssn"));
  const kit = (await ok("records.kits.get", { id: "estate-planning" })).kit;
  assert.equal(kit.id, "estate-planning");
  assert.equal((await call("records.kits.get", { id: "nope" }, { root, caller: "cli" })).error.code, "not_found");
  assert.ok((await call("records.kits.library", {}, { root, caller: "mcp" })).error, "a model caller is refused");
});

test("records.roles and records.holders: what a contact is to the Space, and who holds a role, under the caller's chain", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const ok = async (tool, input, caller = "cli") => { const r = await call(tool, input, { root, caller }); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const role = name => ({ name, label: name, role: { link: "contact", ended: ["Ended"] }, fields: [
    { name: "contact", kind: "link", to: "contact", label: "Contact", required: true },
    { name: "stage", kind: "stage", label: "Stage", options: ["New", "Active", "Ended"] },
  ], stages: [{ name: "New" }, { name: "Active" }, { name: "Ended" }] });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [CONTACT, role("prospect"), role("client")] });
  const jane = (await ok("records.create", { type: "contact", data: { name: "Jane" } })).record;
  const sam = (await ok("records.create", { type: "contact", data: { name: "Sam" } })).record;
  await ok("records.create", { type: "prospect", data: { contact: { urn: jane.urn }, stage: "Ended" } });
  await ok("records.create", { type: "client", data: { contact: { urn: jane.urn }, stage: "Active" } });
  await ok("records.create", { type: "client", data: { contact: { urn: sam.urn }, stage: "New" } });
  const mine = await ok("records.roles", { urn: jane.urn });
  assert.deepEqual(mine.roles.map(r => [r.role, r.current]), [["client", true], ["prospect", false]], "current first, an ended one is still shown");
  assert.deepEqual((await ok("records.roles", { urn: jane.urn, include_ended: false })).roles.map(r => r.role), ["client"]);
  const held = await ok("records.holders", { role: "client" });
  assert.equal(held.rows.length, 2);
  assert.deepEqual((await ok("records.holders", { role: "client", stage: "Active" })).rows.map(r => r.holder), [jane.urn]);
  assert.equal((await ok("records.holders", { role: "prospect" })).rows.length, 0, "an ended role is left out unless asked for");
  assert.equal((await ok("records.holders", { role: "prospect", include_ended: true })).rows.length, 1);
  assert.equal((await call("records.holders", { role: "contact" }, { root, caller: "cli" })).error.code, "bad_input", "a type that is not a role");
  assert.equal((await call("records.roles", { urn: "nonsense" }, { root, caller: "cli" })).error.code, "bad_input");
  for (const caller of ["mcp", "guest:x", "anonymous"]) {
    assert.ok((await call("records.roles", { urn: jane.urn }, { root, caller })).error, `${caller} is refused`);
    assert.ok((await call("records.holders", { role: "client" }, { root, caller })).error, `${caller} is refused`);
  }
});

test("every Space has the core types (contact, communication, event ...) the calendar sync and the logging Flow write to", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const types = (await call("records.types", {}, { root, caller: "cli" })).data.types.map(x => x.name);
  for (const n of ["contact", "contact_point", "organization", "communication", "event"]) assert.ok(types.includes(n), `${n} is defined in a fresh Space`);
  assert.ok(d.registry.deps.flowsHost.get(d.kernel.id.space).calendar, "and the calendar sync is started for the Space");
});
