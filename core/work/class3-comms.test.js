// @ts-check
// Class 3, the per-record read rule (kernel/gateway/records.js PRIVATE_READS): a communication is read by the person whose mailbox it came from, the team of the project it concerns, and staff; a team row by the
// people of its project. A type that is not listed reads as it did. Real daemon, a hosted team Space, both routes (the member door and the gateway), search, aggregate, links and events.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { WIRE_VERSION } from "../../kernel/remote/wire.js";
import * as CORE from "../../records/core-types.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("communication and team-member: a member reads her own mail and her projects' team rows, not another's; staff read all; an unlisted type reads as before", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const K = firm.kernel, SPACE = firm.space, gw = firm.gateway;
  const facts = (/** @type {string} */ p) => ({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "relay" });
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN, ZED]) await gw.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  const chainOf = (/** @type {string} */ p) => K.chains.fromFacts(facts(p));
  const server = createRemoteServer({ space: SPACE, kernel: K, services: {} });
  let n = 0;
  const door = async (/** @type {string} */ person, /** @type {string} */ call, /** @type {any[]} */ ...args) => {
    const r = await server.serve({ v: WIRE_VERSION, id: "r" + (++n), space: SPACE, ts: Date.now(), call, args }, { device_key_id: "dev-" + person.slice(4, 10), person, path: "relay" });
    return r.ok ? { ok: true, v: r.result } : { ok: false, e: `${r.error.code}: ${r.error.message}` };
  };
  const rowsOf = (/** @type {any} */ r) => (r.ok && r.v && (r.v.rows || (Array.isArray(r.v) ? r.v : []))) || [];
  K.kernelFor({ name: "work", needs: { kernel: { membership: true, work: true, attrs: true, actions: ["records.read", "records.create", "records.update", "records.remove"] } } });
  const svc = gw.serviceChain("work");
  const need = (await gw.definitions(ownerChain)); const have = new Set((need.types || need).map((/** @type {any} */ x) => x.name));
  const add = [CORE.COMMUNICATION, CORE.ORGANIZATION, CORE.CONTACT, CORE.PROJECT, CORE.TEAM_MEMBER, CORE.TASK].filter((/** @type {any} */ x) => x && !have.has(x.name));
  if (add.length) await gw.records.define(ownerChain, { add_types: add });
  const comm = (/** @type {string} */ subject, /** @type {any} */ extra = {}, /** @type {any} */ opts = {}) => gw.records.create(ownerChain, "communication", { kind: "email", at: new Date().toISOString(), subject, source_key: "k:" + subject, ...extra }, opts);

  const proj = await gw.records.create(ownerChain, "project", { name: "Harlow", slug: "harlow", status: "active", memory_scope: "project:harlow" });
  const other = await gw.records.create(ownerChain, "project", { name: "Elsewhere", slug: "elsewhere", status: "active", memory_scope: "project:elsewhere" });
  await gw.records.create(ownerChain, "team-member", { name: "Zed", project: { urn: proj.urn }, kind: "person", actor: { actor: { kind: "person", id: ZED, space: SPACE } } });
  await gw.records.create(ownerChain, "team-member", { name: "Ben", project: { urn: other.urn }, kind: "person", actor: { actor: { kind: "person", id: BEN, space: SPACE } } });
  // Ana's own mail (the writer stamps its owner), Ben's, a message nobody owns (only the person who ran the writer: the owner), and one about the project Zed is on
  await comm("ANA-MAIL", {}, { attrs: { owner: ANA } });
  await comm("BEN-MAIL", {}, { attrs: { owner: BEN } });
  await comm("NOBODYS-MAIL");
  await comm("PROJECT-MAIL", { record: { urn: proj.urn } });
  const subjects = (/** @type {any[]} */ rows) => rows.map((/** @type {any} */ r) => r.data.subject).sort();

  const all = (await gw.records.query(ownerChain, "communication", { page: { limit: 50 } })).rows;
  assert.deepEqual(subjects(all), ["ANA-MAIL", "BEN-MAIL", "NOBODYS-MAIL", "PROJECT-MAIL"], "staff read all of them");

  // both routes: the gateway chain and the door
  const via = {
    gateway: async (/** @type {string} */ p) => subjects((await gw.records.query(chainOf(p), "communication", { page: { limit: 50 } })).rows),
    door: async (/** @type {string} */ p) => subjects(rowsOf(await door(p, "records.query", "communication", { page: { limit: 50 } }))),
  };
  for (const [route, read] of Object.entries(via)) {
    assert.deepEqual(await read(ANA), ["ANA-MAIL"], `${route}: Ana reads her own mail only`);
    assert.deepEqual(await read(BEN), ["BEN-MAIL"], `${route}: Ben reads his own only`);
    assert.deepEqual(await read(ZED), ["PROJECT-MAIL"], `${route}: Zed, on the project, reads the project's mail`);
  }
  const benMail = all.find((/** @type {any} */ r) => r.data.subject === "BEN-MAIL");
  assert.equal(await gw.records.get(chainOf(ANA), "communication", benMail.id), null, "gateway get of another's mail");
  assert.ok(!(await door(ANA, "records.get", "communication", benMail.id)).ok || !(await door(ANA, "records.get", "communication", benMail.id)).v, "door get of another's mail");
  assert.ok(!JSON.stringify(await door(ANA, "records.search", { text: "BEN-MAIL", page: { limit: 20 } })).includes("BEN-MAIL"), "door search finds none of another's");
  assert.ok(JSON.stringify(await door(ANA, "records.search", { text: "ANA-MAIL", page: { limit: 20 } })).includes("ANA-MAIL"), "and finds her own");
  assert.ok(!(await door(ANA, "records.aggregate", "communication", { measures: [{ op: "count" }] })).ok, "a total over a private type is refused for a member");
  assert.ok((await gw.records.aggregate(ownerChain, "communication", { measures: [{ op: "count" }] })).length >= 1, "and answered for the owner");
  assert.ok(!(await door(ANA, "records.update", "communication", benMail.id, { subject: "X" }, benMail.version)).ok, "she cannot change another's mail");
  // an event about another's mail is not hers (a subscription opened before the row is written is judged the same way, by canSee)
  const ev = JSON.stringify(await door(ANA, "records.events", { limit: 500 }));
  assert.ok(!ev.includes("BEN-MAIL") && !ev.includes("NOBODYS-MAIL"), "events: nothing of another's mail");

  // the team rows: only those of projects she is on
  const teamOf = async (/** @type {string} */ p) => (await gw.records.query(chainOf(p), "team-member", { page: { limit: 50 } })).rows.map((/** @type {any} */ r) => r.data.name).sort();
  assert.deepEqual(await teamOf(ZED), ["Zed"], "Zed reads the rows of her project");
  assert.deepEqual(await teamOf(BEN), ["Ben"], "Ben reads the rows of his");
  assert.deepEqual(await teamOf(ANA), [], "Ana is on none");
  assert.equal(rowsOf(await door(ANA, "records.query", "team-member", { page: { limit: 50 } })).length, 0, "door: Ana reads no team rows");
  assert.deepEqual((await gw.records.query(ownerChain, "team-member", { page: { limit: 50 } })).rows.map((/** @type {any} */ r) => r.data.name).sort(), ["Ben", "Zed"], "staff read all of them");

  // a type that is not listed reads exactly as before: an organization made by the owner is read by every member
  await gw.records.create(ownerChain, "organization", { name: "ORG-ALL" });
  for (const p of [ANA, BEN, ZED]) assert.ok((await gw.records.query(chainOf(p), "organization", { page: { limit: 50 } })).rows.some((/** @type {any} */ r) => r.data.name === "ORG-ALL"), `an unlisted type: ${p.slice(4, 8)} reads it`);

  // a project is its team's: its owner, the people on its team, staff. A member lists and opens hers, not another's
  const anaProj = await gw.records.create(ownerChain, "project", { name: "ANA-OWN-PROJECT", slug: "ana-own", status: "active", memory_scope: "project:ana-own", owner: { actor: { kind: "person", id: ANA, space: SPACE } } });
  const projNames = async (/** @type {string} */ p) => (await gw.records.query(chainOf(p), "project", { page: { limit: 50 } })).rows.map((/** @type {any} */ r) => r.data.name).sort();
  assert.deepEqual(await projNames(ANA), ["ANA-OWN-PROJECT"], "Ana lists the project she owns and no other");
  assert.deepEqual(await projNames(ZED), ["Harlow"], "Zed lists the one she is on");
  assert.deepEqual(await projNames(BEN), ["Elsewhere"], "Ben lists the one he is on");
  assert.deepEqual((await gw.records.query(ownerChain, "project", { page: { limit: 50 } })).rows.map((/** @type {any} */ r) => r.data.name).sort(), ["ANA-OWN-PROJECT", "Elsewhere", "Harlow"], "staff list all of them");
  assert.ok(await gw.records.get(chainOf(ANA), "project", anaProj.id), "Ana opens her own project");
  assert.equal(await gw.records.get(chainOf(ANA), "project", proj.id), null, "and not another's, by get");
  for (const [route, read] of Object.entries({ gateway: async (/** @type {string} */ p) => projNames(p), door: async (/** @type {string} */ p) => rowsOf(await door(p, "records.query", "project", { page: { limit: 50 } })).map((/** @type {any} */ r) => r.data.name).sort() })) assert.deepEqual(await read(ANA), ["ANA-OWN-PROJECT"], `${route}: Ana's projects`);
  assert.ok(!(await door(ANA, "records.get", "project", proj.id)).v, "door get of another's project");
  assert.ok(!JSON.stringify(await door(ANA, "records.search", { text: "Harlow", page: { limit: 20 } })).includes("Harlow"), "door search finds none of another's project");

  // a task is for its doer and whoever gave it, and for its project's owner and team: read and write name the same people
  await gw.records.create(ownerChain, "task", { title: "PROJECT-TASK", project: { urn: proj.urn } });
  await gw.records.create(ownerChain, "task", { title: "OWNER-ONLY-TASK" });
  await gw.records.create(chainOf(ANA), "task", { title: "ANA-OWN-TASK" });
  const taskTitles = async (/** @type {string} */ p) => (await gw.records.query(chainOf(p), "task", { page: { limit: 50 } })).rows.map((/** @type {any} */ r) => r.data.title).sort();
  assert.ok((await taskTitles(ZED)).includes("PROJECT-TASK"), "Zed, on the project, reads its task");
  assert.ok(!(await taskTitles(ANA)).includes("PROJECT-TASK") && !(await taskTitles(ANA)).includes("OWNER-ONLY-TASK"), "Ana reads neither a project she is not on nor the owner's own task");
  assert.ok((await taskTitles(ANA)).includes("ANA-OWN-TASK"), "Ana reads the task she made");
  assert.ok(!(await taskTitles(BEN)).includes("ANA-OWN-TASK") && !(await taskTitles(BEN)).includes("PROJECT-TASK"), "Ben reads neither");
  assert.ok((await gw.records.query(ownerChain, "task", { page: { limit: 50 } })).rows.length >= 3, "staff read every task");
  // the tasks service (tasks.list, tasks.get: the Store's Now and Tasks) follows the same people
  const askTitles = async (/** @type {string} */ p) => (await gw.ask.list(chainOf(p))).map((/** @type {any} */ x) => x.title).sort();
  assert.ok((await askTitles(ANA)).includes("ANA-OWN-TASK") && !(await askTitles(ANA)).includes("OWNER-ONLY-TASK") && !(await askTitles(ANA)).includes("PROJECT-TASK"), "tasks.list: Ana lists her own task and neither the owner's own nor a project she is not on");
  assert.ok((await askTitles(ZED)).includes("PROJECT-TASK") && !(await askTitles(ZED)).includes("ANA-OWN-TASK"), "tasks.list: Zed lists the task of the project she is on, not Ana's");
  assert.deepEqual((await gw.ask.list(ownerChain)).map((/** @type {any} */ x) => x.title).sort(), ["ANA-OWN-TASK", "OWNER-ONLY-TASK", "PROJECT-TASK"], "tasks.list: staff list every task");
  const ownerTask = (await gw.ask.list(ownerChain)).find((/** @type {any} */ x) => x.title === "OWNER-ONLY-TASK");
  assert.equal(await gw.ask.get(chainOf(ANA), ownerTask.id), null, "tasks.get: Ana cannot open the owner's own task");
  assert.ok(await gw.ask.get(ownerChain, ownerTask.id), "and the owner can");

  // a file's events (written, read, moved, deleted) are judged like the file: someone who may not open it learns nothing of it, not its path, size or who touched it. Events read from the start of the log, on both routes.
  const secretPath = `Projects/${proj.id}/FILE-EVENT-SECRET.txt`, anaPath = `Projects/${anaProj.id}/ANA-FILE.txt`;
  await gw.drive.put(ownerChain, secretPath, new TextEncoder().encode("owner's file in the Harlow project"));
  await gw.drive.put(ownerChain, anaPath, new TextEncoder().encode("a file in Ana's project"));
  await gw.drive.get(ownerChain, secretPath);   // a read is an event too
  const evOf = async (/** @type {string} */ p) => JSON.stringify([await door(p, "events.read", {}), await door(p, "events.read", { limit: 500 }), await door(p, "events.read", { since: 0 }), (await gw.events.read(chainOf(p), { since: 0, limit: 500 }))]);
  for (const who of [ANA, BEN]) assert.ok(!(await evOf(who)).includes("FILE-EVENT-SECRET"), `${who.slice(4, 8)}: no event of a file in a project she is not on`);
  assert.ok(JSON.stringify(await gw.events.read(ownerChain, { since: 0, limit: 500 })).includes("FILE-EVENT-SECRET"), "the owner sees them");

  // a checker who is neither the doer, the giver nor on the project reads the task she checks, on both routes; and she cannot change what only the doer may
  const actorOf = (/** @type {string} */ id) => ({ kind: "person", id, space: SPACE });
  const checked = await gw.ask.request(ownerChain, { title: "CHECKED-TASK", doer: actorOf(BEN), checker: actorOf(ZED), output: { kind: "note" } });
  assert.ok((await taskTitles(ZED)).includes("CHECKED-TASK"), "the checker reads the task through records.query");
  assert.ok(await gw.ask.get(chainOf(ZED), checked.id), "and through tasks.get");
  assert.ok((await askTitles(ZED)).includes("CHECKED-TASK"), "and tasks.list");
  assert.ok(!(await taskTitles(ANA)).includes("CHECKED-TASK") && (await gw.ask.get(chainOf(ANA), checked.id)) === null, "a stranger reads it by neither");
  await assert.rejects(gw.ask.start(chainOf(ZED), checked.id), /only the doer|not_allowed|may not|not allowed/i, "the checker cannot do what only the doer does");
  // only the chain's PERSON counts: a member's chain with an agent behind it reads as the member, the owner's as the owner
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await gw.grants.addActor(ownerChain, kit, { presence: proof() });
  const owned = await gw.ask.request(ownerChain, { title: "KITS-TASK", doer: kit, output: { kind: "note" } });
  const anaWithKit = K.chains.fromFacts({ kind: "agent_session", vouched: true, person: ANA, agent: "kit", session: "sa" });
  assert.equal(await gw.ask.get(anaWithKit, owned.id), null, "a member's chain with an agent behind it reads as the member, not as the agent's task");

  // a member cannot widen her own view with a grant: only an owner or an admin gives access (the rule for a grant that names a row scope is pinned in records/comms/log.test.js)
  const grantSpec = (/** @type {string} */ person) => ({ subject: { kind: "actor", actor: { kind: "person", id: person, space: SPACE } }, actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/communication/*`, where: [{ attr: "project", op: "eq", value: "px" }] }, reason: "class 3 test", conditions: {}, source: "test" });
  await comm("PX-MAIL", {}, { attrs: { project: "px" } });
  await assert.rejects(gw.grants.create(chainOf(BEN), grantSpec(BEN), { presence: { n: Math.random() } }), "a member cannot issue a grant to herself");
  assert.ok(!(await gw.records.query(chainOf(BEN), "communication", { page: { limit: 50 } })).rows.some((/** @type {any} */ r) => r.data.subject === "PX-MAIL"), "and the refused grant opened nothing");
});
