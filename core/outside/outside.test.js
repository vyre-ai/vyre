// @ts-check
// Outside agents on a real daemon: an agent registered by the person reads only what it was given (sealed fields as words), asks before it changes anything, is held to its token and its limits, and stops
// at once when it is ended. Fakes only; a temp home.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { CONTACT } from "../../kernel/conformance/suite.js";
import { LIMITS } from "../../lib/outside.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

/** A real box with one contact (a sealed SSN) and a type the agent is never given. */
async function rig(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (tool, input, caller = "cli", meta) => d.registry.call(tool, input, caller, meta);
  const ok = async (tool, input, caller) => { const r = await call(tool, input, caller); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(owner, { add_types: [CONTACT, { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }] }] });
  const jane = (await ok("records.create", { type: "contact", data: { name: "Jane Doe", age: 40 } })).record;
  await ok("records.seal-put", { urn: jane.urn, field: "ssn", value: "123-45-6789", class: "us-ssn" });
  const secret = (await ok("records.create", { type: "matter", data: { title: "Harlow v. Harlow" } })).record;
  const outside = d.registry.modules.get("outside").handle.handle;
  assert.ok(outside, "the outside module is running");
  const rpc = (token, method, params, source = "10.0.0.1") => outside({ method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), source });
  const tools = async token => (await rpc(token, "tools/list")).body.result.tools.map(x => x.name);
  const use = async (token, name, args) => { const r = await rpc(token, "tools/call", { name, arguments: args }); const res = r.body && r.body.result; return { status: r.status, error: res && res.isError, text: res && res.content ? res.content[0].text : "", json: res && !res.isError && res.content ? JSON.parse(res.content[0].text) : null }; };
  const heldList = async () => { const h = await ok("gate.held", {}); return Array.isArray(h) ? h : h.items || h.held || []; };
  const events = [];
  d.events.on("outside.*", e => events.push(e));
  return { d, call, ok, jane, secret, rpc, tools, use, events, owner, heldList };
}

test("an outside agent reaches only what it was given, and sealed values come back as words", { timeout: 120_000 }, async t => {
  const { ok, call, jane, secret, rpc, tools, use } = await rig(t);
  const reg = await ok("outside.register", { name: "Muse", note: "writes our newsletter" });
  assert.match(reg.token, /^vext_[A-Za-z0-9_-]{43}$/);
  assert.match(reg.id, /^[a-z0-9]{24}$/);
  assert.ok(!JSON.stringify(await ok("outside.list", {})).includes(reg.token), "a token is shown once and never listed");

  // a good token with nothing given: it can say who it is and nothing else
  assert.deepEqual(await tools(reg.token), ["whoami"]);
  assert.match((await use(reg.token, "whoami", {})).json.reach, /nothing yet/);
  assert.match((await use(reg.token, "records_list", { type: "contact" })).text, /needs the person to give you more access/);
  assert.equal((await rpc("vext_wrong", "tools/list")).status, 401);

  // given the contact type to read
  const g = await ok("outside.grant", { id: reg.id, what: { kind: "records", types: ["contact"] } });
  assert.match(g.reach, /reads contact/);
  assert.deepEqual(await tools(reg.token), ["whoami", "records_types", "records_list", "records_get"]);
  const types = (await use(reg.token, "records_types", {})).json.types;
  assert.deepEqual(types.map(x => x.name), ["contact"]);
  const list = (await use(reg.token, "records_list", { type: "contact" })).json;
  assert.equal(list.records.length, 1);
  assert.equal(list.records[0].fields.name, "Jane Doe");
  assert.equal(list.records[0].fields.ssn, "[sealed]", "a sealed field is a word, never the value or its reference");
  const got = (await use(reg.token, "records_get", { urn: jane.urn })).json;
  assert.equal(got.title, "Jane Doe");
  assert.ok(got.fields.some(f => f.label === "SSN" && f.hidden === true));
  const wire = JSON.stringify([list, got, types]);
  assert.ok(!wire.includes("123-45-6789"), "the value is nowhere");

  // a type it was not given is not there, the same as one that does not exist
  const other = await use(reg.token, "records_get", { urn: secret.urn });
  assert.match(other.text, /was not found for you/);
  assert.equal((await use(reg.token, "records_list", { type: "matter" })).error, true);
  assert.equal((await use(reg.token, "records_list", { type: "nonesuch" })).text, (await use(reg.token, "records_list", { type: "matter" })).text.replace("matter", "nonesuch"));

  // the agent is not a person, a module or a model session
  for (const who of ["mcp", "harness", "module:outside"]) assert.ok((await call("outside.register", { name: "X" }, who)).error, `${who} cannot register`);
  assert.ok((await call("outside.grant", { id: reg.id, what: { kind: "records", types: ["matter"] } }, "mcp")).error, "a model cannot give an agent access");
  assert.ok((await call("outside.revoke", { id: reg.id }, "mcp")).error, "a model cannot end one either");
});

test("a write waits at the Gate: nothing changes until the person says yes, and a no changes nothing", { timeout: 120_000 }, async t => {
  const { ok, call, rpc, use, events, heldList, jane } = await rig(t);
  const reg = await ok("outside.register", { name: "Muse" });
  await ok("outside.grant", { id: reg.id, what: { kind: "records", types: ["contact"] } });
  assert.match((await use(reg.token, "records_create", { type: "contact", fields: { name: "Dana Reyes" } })).text, /needs the person to give you more access|write access/, "read access is not write access");
  await ok("outside.grant", { id: reg.id, what: { kind: "records", types: ["contact"], write: true } });
  assert.deepEqual((await ok("outside.list", {})).agents[0].gives.map(g => g.write === true), [true], "giving again for the same type replaces the row, it does not add one");
  const asked = await use(reg.token, "records_create", { type: "contact", fields: { name: "Dana Reyes", age: 31 } });
  assert.ok(asked.json && /^hd_/.test(asked.json.held), JSON.stringify(asked));
  assert.equal((await ok("records.list", { type: "contact" })).rows.filter(r => r.data.name === "Dana Reyes").length, 0, "nothing was made yet");
  const item = (await heldList()).find(x => /Muse wants to add a contact: Dana Reyes/.test(x.summary || ""));
  assert.ok(item, "the card says who wants what");
  assert.equal((await use(reg.token, "held_get", { held: asked.json.held })).json.state, "waiting");
  assert.ok((await call("gate.approve", { id: item.id }, "mcp")).error, "a model does not approve for the person");
  const done = await ok("gate.approve", { id: item.id });
  assert.equal(done.state, "sent", JSON.stringify(done));
  const made = (await ok("records.list", { type: "contact" })).rows.filter(r => r.data.name === "Dana Reyes");
  assert.equal(made.length, 1, "approved: it was made");
  assert.equal((await use(reg.token, "held_get", { held: asked.json.held })).json.state, "done");

  // a change to a record it can read: held, approved, and made as the agent
  const upd = await use(reg.token, "records_update", { urn: jane.urn, fields: { age: 41 } });
  assert.ok(upd.json && /^hd_/.test(upd.json.held), JSON.stringify(upd));
  assert.equal((await ok("records.get", { urn: jane.urn })).record.data.age, 40, "nothing changed yet");
  const item3 = (await heldList()).find(x => /Muse wants to change a contact/.test(x.summary || ""));
  assert.ok(item3, "the card says it is a change");
  assert.equal((await ok("gate.approve", { id: item3.id })).state, "sent");
  assert.equal((await ok("records.get", { urn: jane.urn })).record.data.age, 41, "approved: it was changed");
  assert.equal((await use(reg.token, "held_get", { held: upd.json.held })).json.state, "done");
  // a no
  const second = await use(reg.token, "records_create", { type: "contact", fields: { name: "Nope Person" } });
  const item2 = (await heldList()).find(x => /Nope Person/.test(x.summary || ""));
  await ok("gate.reject", { id: item2.id });
  assert.equal((await use(reg.token, "held_get", { held: second.json.held })).json.state, "declined");
  assert.equal((await ok("records.list", { type: "contact" })).rows.filter(r => r.data.name === "Nope Person").length, 0);

  // another agent cannot read this one's request
  const other = await ok("outside.register", { name: "Hermes" });
  assert.match((await use(other.token, "held_get", { held: asked.json.held })).text, /not something you asked for|more access/);
  assert.ok(events.some(e => e.type === "outside.held"));
});

test("ending an agent takes everything back at once, even a request it is still waiting on", { timeout: 120_000 }, async t => {
  const { ok, call, rpc, use, events, heldList } = await rig(t);
  const reg = await ok("outside.register", { name: "Muse" });
  await ok("outside.grant", { id: reg.id, what: { kind: "records", types: ["contact"], write: true } });
  await use(reg.token, "records_create", { type: "contact", fields: { name: "Late Arrival" } });
  const item = (await heldList()).find(x => /Late Arrival/.test(x.summary || ""));
  assert.equal((await ok("outside.revoke", { id: reg.id })).revoked, true);
  assert.equal((await rpc(reg.token, "tools/list")).status, 401, "the token opens nothing");
  assert.ok(!(await heldList()).some(x => x.id === item.id), "the card left the person's list: nobody can act on it");
  const done = await call("gate.approve", { id: item.id });
  assert.notEqual(done.data && done.data.state, "sent", "an item approved after the end does nothing: " + JSON.stringify(done));
  assert.equal((await ok("records.list", { type: "contact" })).rows.filter(r => r.data.name === "Late Arrival").length, 0);
  assert.equal((await ok("outside.revoke", { id: reg.id })).revoked, false, "ending twice is harmless");
  assert.ok(events.some(e => e.type === "outside.revoked"));
});

test("a leaked or guessed token is counted per address and locks that address out; what is recorded carries names and addresses, never values", { timeout: 120_000 }, async t => {
  const { ok, rpc, use, events, jane } = await rig(t);
  const reg = await ok("outside.register", { name: "Muse" });
  await ok("outside.grant", { id: reg.id, what: { kind: "records", types: ["contact"] } });
  for (let i = 0; i < LIMITS.badTokens; i++) assert.equal((await rpc(`vext_bad${i}`, "tools/list", undefined, "6.6.6.6")).status, 401);
  assert.equal((await rpc(reg.token, "tools/list", undefined, "6.6.6.6")).status, 429, "that address is locked out even with the right token");
  assert.equal((await rpc(reg.token, "tools/list", undefined, "10.1.1.1")).status, 200, "another address is not");
  assert.equal((await rpc(reg.token, "tools/list", undefined, "10.1.1.1")).status, 200);
  await use(reg.token, "records_get", { urn: jane.urn });
  const text = JSON.stringify(events.map(e => e.payload));
  for (const v of ["Jane Doe", "123-45-6789", reg.token]) assert.ok(!text.includes(v), `${v} is not in an event`);
  assert.ok(events.some(e => e.type === "outside.used" && e.payload.tool === "records_get" && e.payload.resource === jane.urn));
  assert.ok(events.some(e => e.type === "outside.refused"));
});

test("an outside caller label reaches no tool of the registry", { timeout: 120_000 }, async t => {
  const { d, call } = await rig(t);
  const label = "ext:k3m9x2q7pw4t";
  const names = [...d.registry.tools.keys()];
  /** @type {string[]} */ const reached = [];
  for (const n of names) { const r = await call(n, { "__probe__": 1 }, label, {}); if (!r.error || !["denied", "not_allowed", "no_such_tool", "forbidden", "held_unavailable"].includes(r.error.code)) reached.push(`${n}: ${r.error ? r.error.code : "ran"}`); }
  assert.deepEqual(reached, [], "every tool refuses an ext label unless its callers list names ext");
  for (const bad of ["ext", "ext:", "ext:SHORT", "ext:a:agent:x"]) assert.ok((await call("records.types", {}, bad, {})).error, bad);
});

test("memory and files of a project it was given are asked and read through the kernel, and nothing of another project", { timeout: 120_000 }, async t => {
  const { d, ok, call, rpc, use, tools, jane, owner } = await rig(t);
  const made = await ok("work.project.create", { name: "Harlow Matter" });
  const other = await ok("work.project.create", { name: "Northwind Bakery" });
  const id = String(made.project).split("/").pop();
  await ok("files.drive.upload", { path: `${made.drive_path}/notes.txt`, base64: Buffer.from("Dana pays on the 15th").toString("base64") });
  await ok("files.drive.upload", { path: `${other.drive_path}/menu.txt`, base64: Buffer.from("not for Muse").toString("base64") });
  await d.kernel.gateway.memory.file(owner, { text: "Harlow settles on the 15th", source: jane.urn, kind: "decision", scope: `project:${id}` });
  // a fact for the whole Space, and one of another project: neither is the memory of Harlow Matter
  await d.kernel.gateway.memory.file(owner, { text: "Everyone settles on the 1st: the firm's own rule", source: jane.urn, kind: "decision" });
  await d.kernel.gateway.memory.file(owner, { text: "Northwind settles on the 9th", source: jane.urn, kind: "decision", scope: `project:${String(other.project).split("/").pop()}` });
  const reg = await ok("outside.register", { name: "Muse" });
  await ok("outside.grant", { id: reg.id, what: { kind: "files", project: made.slug } });
  await ok("outside.grant", { id: reg.id, what: { kind: "memory", project: made.slug } });
  assert.deepEqual(await tools(reg.token), ["whoami", "memory_ask", "files_read"]);

  const dir = (await use(reg.token, "files_read", { project: made.slug })).json;
  assert.deepEqual(dir.files.map(f => f.name), ["notes.txt"], JSON.stringify(dir));
  assert.equal((await use(reg.token, "files_read", { project: made.slug, path: "notes.txt" })).json.text, "Dana pays on the 15th");
  assert.match((await use(reg.token, "files_read", { project: made.slug, path: "chat/chat_x/private.txt" })).text, /was not found for you/, "a chat's folder is not the project's files");
  assert.match((await use(reg.token, "files_read", { project: made.slug, path: ".project" })).text, /was not found for you/);
  assert.match((await use(reg.token, "files_read", { project: other.slug })).text, /not a project you were given/);
  assert.match((await use(reg.token, "files_read", { project: made.slug, path: "../" + String(other.drive_path).split("/").pop() + "/menu.txt" })).text, /inside the project's folder/);
  const asked = (await use(reg.token, "memory_ask", { project: made.slug, question: "settles" })).json;
  assert.deepEqual(asked.facts.map(f => f.text), ["Harlow settles on the 15th"]);
  assert.match((await use(reg.token, "memory_ask", { project: other.slug, question: "settles" })).text, /not a project you were given/);
  void call; void rpc;
});

test("an outside agent cannot flood the Gate: a few changes waiting at a time, each of a sane size", { timeout: 120_000 }, async t => {
  const { ok, use, heldList } = await rig(t);
  const reg = await ok("outside.register", { name: "Muse" });
  await ok("outside.grant", { id: reg.id, what: { kind: "records", types: ["contact"], write: true } });
  assert.match((await use(reg.token, "records_create", { type: "contact", fields: { name: "x", notes: "y".repeat(25_000) } })).text, /too large/);
  for (let i = 0; i < 20; i++) assert.ok((await use(reg.token, "records_create", { type: "contact", fields: { name: `Person ${i}` } })).json, `request ${i}`);
  assert.match((await use(reg.token, "records_create", { type: "contact", fields: { name: "one too many" } })).text, /20 of your requests are already waiting/);
  assert.equal((await heldList()).filter(x => /Muse wants to add/.test(x.summary || "")).length, 20);
});

test("a change the person approves later applies only to the record as it was asked about", { timeout: 120_000 }, async t => {
  const { ok, use, jane, heldList } = await rig(t);
  const reg = await ok("outside.register", { name: "Muse" });
  await ok("outside.grant", { id: reg.id, what: { kind: "records", types: ["contact"], write: true } });
  const asked = await use(reg.token, "records_update", { urn: jane.urn, fields: { age: 41 } });
  assert.ok(asked.json && asked.json.held, JSON.stringify(asked));
  // the person edits the same record while the request waits
  await ok("records.update", { urn: jane.urn, patch: { age: 52 } });
  const item = (await heldList()).find(x => /Muse wants to change a contact/.test(x.summary || ""));
  await ok("gate.approve", { id: item.id }).catch(() => {});
  assert.equal((await ok("records.get", { urn: jane.urn })).record.data.age, 52, "the newer edit was not overwritten");
  const state = (await use(reg.token, "held_get", { held: asked.json.held })).json;
  assert.equal(state.state, "failed", JSON.stringify(state));
});

test("a new token with days keeps an agent and what it was given for that long", { timeout: 120_000 }, async t => {
  const { ok, use, tools } = await rig(t);
  const reg = await ok("outside.register", { name: "Muse", days: 1 });
  await ok("outside.grant", { id: reg.id, what: { kind: "records", types: ["contact"] } });
  const before = (await ok("outside.list", {})).agents[0];
  const again = await ok("outside.token", { id: reg.id, days: 30 });
  const after = (await ok("outside.list", {})).agents[0];
  assert.ok(after.expires > before.expires + 20 * 86400_000, "the agent lasts the longer time");
  assert.equal(after.gives.length, 1, "what it was given is one line still");
  assert.deepEqual(await tools(again.token), ["whoami", "records_types", "records_list", "records_get"]);
  assert.ok((await use(again.token, "records_list", { type: "contact" })).json, "and it still reads");
});
