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
  assert.equal(noProof.error && noProof.error.code, "needs_presence", "changing the types is the person's act, with their presence");
  // the development stand-in (the owner's hand-made file): the same call now goes through, and the log says it was a stand-in
  const fsx = await import("node:fs"), pathx = await import("node:path");
  fsx.writeFileSync(pathx.join(root, "dev-presence-stand-in"), "");
  const viaStandIn = await call("records.define", { diff: { add_types: [CONTACT] } }, { root, caller: "cli" });
  assert.ok(!viaStandIn.error, JSON.stringify(viaStandIn));
  assert.ok(d.kernel.log.read({ type: "presence.stand-in" }).length >= 1 && d.kernel.log.read({ type: "presence.stand-in" }).every(e => e.data.method === "stand-in"), "every use is recorded as a stand-in");
  fsx.rmSync(pathx.join(root, "dev-presence-stand-in"));
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [CONTACT] }).catch(() => {});
  const types = await ok("records.types", {});
  assert.ok(JSON.stringify(types).includes("contact"));
  assert.ok(types.types.every(t => !t.system && !/^(def-|flow-)/.test(t.name) && t.name !== "goal"), "the kernel's own types are left out by default: " + types.types.map(t => t.name));
  assert.ok((await ok("records.types", { system: true })).types.some(t => t.system === true), "and flagged when asked for");
  // a type may say it is a project (the app lists Projects by that, no names hard-coded); the store keeps it and records.types returns it
  await d.kernel.gateway.records.define(ownerChain, { add_types: [{ name: "matter", label: "Matter", kind: "project", fields: [{ name: "title", kind: "text", label: "Title" }] }] });
  assert.equal((await ok("records.types", {})).types.find(t => t.name === "matter").kind, "project");
  const made = (await ok("records.create", { type: "contact", data: { name: "Jane", age: 40 } })).record;
  assert.equal(made.data.name, "Jane");
  const page = await ok("records.list", { type: "contact", limit: 10 });
  assert.equal(page.rows.length, 1);
  const got = (await ok("records.get", { urn: made.urn })).record;
  assert.equal(got.data.name, "Jane");
  const upd = (await ok("records.update", { urn: made.urn, patch: { age: 41 }, base_version: got.version })).record;
  assert.equal(upd.data.age, 41);
  const stale = await call("records.update", { urn: made.urn, patch: { age: 42 }, base_version: got.version }, { root, caller: "cli" });
  assert.equal(stale.error && stale.error.code, "version_conflict");
  assert.equal((await ok("records.me", {})).person, d.kernel.id.owner);
  assert.ok((await ok("records.actors", {})).actors.some(a => a.id === d.kernel.id.owner));
  // refused: models, guests, anonymous, a module
  for (const caller of ["mcp", "mcp:agent:kit", "tailnet-guest:x", "anonymous"]) {
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
});
