// @ts-check
// Class 3 (the owner's ruling of 12 Oct): a chat's record and a file share are private to the people involved, the project's team, the owner and the admins, on every route. A member has no raw Records route to either
// (the door and the gateway); she reads her chats through the work module (work.chat.list, the chat service), which keeps the records she may see. Real daemon, a hosted-free Space with an owner and members.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { WIRE_VERSION } from "../../kernel/remote/wire.js";
import { createHub } from "./hub.js";
import { shareFile, unshareFile, readers } from "./shares.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a chat and a file share: a member reads and changes none she is not part of, on the door and the gateway; the people in it, the project's team and the owner do", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });   // a hosted team Space: where members' chats live (chat-service.test.js)
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
  const handle = /** @type {any} */ (d.registry.modules.get("work")).handle;
  const svc = handle.peerService({ space: SPACE, kernel: K, registry: d.registry });
  const OWNERIN = ownerChain;
  const as = (/** @type {string} */ p, /** @type {string} */ call, input = {}) => svc[call](chainOf(p), input);
  const rowsOf = (/** @type {any} */ r) => (r.ok && r.v && (r.v.rows || (Array.isArray(r.v) ? r.v : []))) || [];

  // Ana's own chat, a chat she shares with Ben, and the owner's chat (made through the work module, as the app does)
  const anaOnly = (await as(ANA, "create", { title: "ANA-ONLY-TITLE" })).chat;
  const shared = (await as(ANA, "create", { title: "ANA-BEN-TITLE", people: [BEN] })).chat;
  const ownerChat = (await as(BEN, "create", { title: "OWNER-CHAT-TITLE" })).chat;   // Ben's own chat: neither Ana nor Zed is in it
  assert.ok(anaOnly && shared && ownerChat, "the three chats exist");
  const svcRead = (await gw.records.query(gw.serviceChain("work"), "chat-record", { page: { limit: 50 } })).rows;
  const recOf = (/** @type {string} */ chat) => { const r = svcRead.find((/** @type {any} */ x) => x.data.chat === chat); assert.ok(r, "the chat record exists"); return r; };

  // the owner reads every record on the raw route
  const ownerAll = (await gw.records.query(ownerChain, "chat-record", { page: { limit: 50 } })).rows;
  assert.ok(ownerAll.length >= 3, "the owner reads every chat record");

  // a member has no raw route to any of them, her own included: the door and the gateway
  for (const who of [ANA, BEN, ZED]) {
    assert.equal(rowsOf(await door(who, "records.query", "chat-record", { page: { limit: 50 } })).length, 0, `${who.slice(4, 8)}: door query`);
    assert.ok(!(await door(who, "records.get", "chat-record", recOf(anaOnly).id)).ok, `${who.slice(4, 8)}: door get`);
    for (const text of ["ANA-ONLY-TITLE", "OWNER-CHAT-TITLE", "ANA-BEN-TITLE"]) assert.ok(!JSON.stringify(await door(who, "records.search", { text })).includes(text), `${who.slice(4, 8)}: door search ${text}`);
    assert.equal((await gw.records.query(chainOf(who), "chat-record", { page: { limit: 50 } })).rows.length, 0, `${who.slice(4, 8)}: gateway query`);
    assert.equal(await gw.records.get(chainOf(who), "chat-record", recOf(anaOnly).id), null, `${who.slice(4, 8)}: gateway get`);
    assert.ok(!(await door(who, "records.update", "chat-record", recOf(anaOnly).id, { title: "CHANGED" }, recOf(anaOnly).version)).ok, `${who.slice(4, 8)}: door update`);
    assert.ok(!(await door(who, "records.remove", "chat-record", recOf(anaOnly).id, recOf(anaOnly).version)).ok, `${who.slice(4, 8)}: door remove`);
    assert.ok(!(await door(who, "records.events", { subject_prefix: "vyre://", limit: 500 })).v || !JSON.stringify(await door(who, "records.events", { limit: 500 })).includes("ANA-ONLY-TITLE"), `${who.slice(4, 8)}: events`);
  }

  // through the work module each sees the chats she is in, and no one else's
  const titles = async (/** @type {string} */ p) => (await as(p, "list", {})).chats.map((/** @type {any} */ c) => c.title || (c.data && c.data.title) || "");
  assert.ok((await titles(ANA)).some((/** @type {string} */ x) => /ANA-ONLY-TITLE/.test(x)) && (await titles(ANA)).some((/** @type {string} */ x) => /ANA-BEN-TITLE/.test(x)), "Ana lists her chats");
  assert.ok(!(await titles(ANA)).some((/** @type {string} */ x) => /OWNER-CHAT-TITLE/.test(x)), "Ana does not list Ben's own chat");
  assert.ok((await titles(BEN)).some((/** @type {string} */ x) => /ANA-BEN-TITLE/.test(x)) && !(await titles(BEN)).some((/** @type {string} */ x) => /ANA-ONLY-TITLE/.test(x)), "Ben lists the shared chat and not Ana's own");
  assert.ok(!(await titles(ZED)).some((/** @type {string} */ x) => /TITLE/.test(x)), "Zed lists none");

  // the project's team: a chat filed under a project is also visible to its team (and to no other member)
  const proj = await gw.records.create(gw.serviceChain("work"), "project", { name: "Harlow", slug: "harlow", status: "active", memory_scope: "project:harlow" });
  await gw.records.create(gw.serviceChain("work"), "team-member", { name: "Zed", project: { urn: proj.urn }, kind: "person", actor: { actor: { kind: "person", id: ZED, space: SPACE } } });
  await gw.records.update(gw.serviceChain("work"), "chat-record", recOf(anaOnly).id, { project: { urn: proj.urn } }, recOf(anaOnly).version);
  const teamSees = async (/** @type {string} */ p) => (await titles(p)).some((/** @type {string} */ x) => /ANA-ONLY-TITLE/.test(x));
  assert.equal(await teamSees(ZED), true, "a member on the project's team sees a chat filed under it");
  assert.equal(await teamSees(BEN), false, "a member not on the project's team still does not see it");

  // a file share: made by the work module for the sharer (created_for), invisible on the raw routes to every member, kept for her and the owner
  const path = `Projects/${proj.id}/chat/${anaOnly}/SHARED-FILE.txt`;
  const sh = await gw.records.create(gw.serviceChain("work"), "file-share", { path }, { on_behalf: chainOf(ANA) });
  assert.equal(String(((await gw.records.attrsOf(sh.urn)) || {}).created_for), `person:${ANA}`, "the share is the sharer's");
  for (const who of [ANA, BEN, ZED]) {
    assert.equal(rowsOf(await door(who, "records.query", "file-share", { page: { limit: 50 } })).length, 0, `${who.slice(4, 8)}: door query of shares`);
    assert.ok(!JSON.stringify(await door(who, "records.search", { text: "SHARED-FILE" })).includes("SHARED-FILE"), `${who.slice(4, 8)}: door search of shares`);
    assert.ok(!(await door(who, "records.create", "file-share", { path })).ok, `${who.slice(4, 8)}: door create of a share`);
    assert.ok(!(await door(who, "records.remove", "file-share", sh.id, sh.version)).ok, `${who.slice(4, 8)}: door remove of a share`);
  }
  assert.equal((await gw.records.query(ownerChain, "file-share", { page: { limit: 50 } })).rows.length, 1, "the owner reads the share");

  // through the work module's own share and unshare (shares.js), as the app's tools run them, on this Space's kernel and hub
  const WK = K.kernelFor({ name: "work", needs: { kernel: { membership: true, work: true, attrs: true, actions: ["records.read", "records.create", "records.update", "records.remove"] } } });   // the work module's own handle on this Space
  const hub = createHub({ kernel: WK, call: async () => null, log: () => {} });
  const { shareRows } = readers(WK, hub);
  const sharedPath = `Projects/${proj.id}/chat/${shared}/BY-WORK.txt`;
  const made = await shareFile(WK, hub, chainOf(ANA), { path: sharedPath });   // Ana is in the chat she shares with Ben
  assert.equal(made.shared, true, "Ana shares a file of her chat");
  await assert.rejects(shareFile(WK, hub, chainOf(ZED), { path: sharedPath }), /not in a chat of yours/, "an outsider cannot share a file of a chat she is not in");
  const seesShare = async (/** @type {string} */ p) => (await shareRows(chainOf(p), { page: { limit: 50 } })).some((/** @type {any} */ r) => String(r.data.path) === sharedPath);
  assert.equal(await seesShare(ANA), true, "the sharer sees her share");
  assert.equal(await seesShare(BEN), true, "a person in the chat sees it");
  assert.equal(await seesShare(ZED), true, "a member on the project's team sees it");
  assert.equal((await shareRows(chainOf(ZED), { page: { limit: 50 } })).some((/** @type {any} */ r) => String(r.data.path) === path), true, "and the share in the project's other chat too (the team of the project in its path)");
  // a share is the sharer's to take back: another person in the chat cannot, an outsider cannot, the sharer and the owner can
  assert.equal((await unshareFile(WK, hub, chainOf(BEN), { path: sharedPath })).unshared, 0, "another person in the chat cannot take her share back");
  assert.equal((await unshareFile(WK, hub, chainOf(ZED), { path: sharedPath })).unshared, 0, "a team member cannot");
  assert.equal(await seesShare(ANA), true, "and the share is still there");
  assert.equal((await unshareFile(WK, hub, chainOf(ANA), { path: sharedPath })).unshared, 1, "the sharer takes it back");
  const again = await shareFile(WK, hub, chainOf(ANA), { path: sharedPath });
  assert.ok(again.id);
  assert.equal((await unshareFile(WK, hub, ownerChain, { path: sharedPath })).unshared, 1, "the owner takes any share back");

  // link reads: the owner still reads a project's chats through a link, a member reads none through one
  const linkedChats = async (/** @type {any} */ chain) => (await gw.records.linked(chain, proj.urn, { type: "chat-record", limit: 50 })).rows;
  assert.ok((await linkedChats(ownerChain)).length >= 1, "the owner reads the project's chats through a link");
  assert.equal((await linkedChats(chainOf(ZED))).length, 0, "a member reads none of them through a link");
});
