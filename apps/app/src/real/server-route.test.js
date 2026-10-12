// @ts-check
// Which server a call goes to (server-route.js): the one named, else the one that hosts the Space the call is for or the Space showing, else the active one. A server this device is not paired to is refused
// with a next step and never answered by another server.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { chatServersFrom, mergeSpaceLists, needsSpace, serverFor, spaceServersFrom } from "./server-route.js";

const A = "spc_aaaaaaaaaaaa", B = "spc_bbbbbbbbbbbb", C = "spc_cccccccccccc";
const spaceServers = { [A]: "boxa", [B]: "boxb" };
const paired = ["boxa", "boxb"];
const go = (/** @type {any} */ o) => serverFor({ input: {}, showing: "all", spaceServers, paired, ...o });

test("route: a call names its server and gets it, whatever Space is showing", () => {
  assert.deepEqual(go({ explicit: "boxb", showing: A }), { box: "boxb" });
});

test("route: a server that is not paired is refused with a next step, not answered by another", () => {
  const r = go({ explicit: "boxz" });
  assert.equal(r.error?.code, "server_not_paired");
  assert.match(r.error?.message ?? "", /Settings, Servers/);
  assert.equal(r.box, undefined);
});

test("route: a call that names a Space goes to the server that hosts it", () => {
  assert.deepEqual(go({ input: { space: B }, showing: A }), { box: "boxb" });
});

test("route: no Space named, the Space showing decides", () => {
  assert.deepEqual(go({ showing: B }), { box: "boxb" });
  assert.deepEqual(go({ showing: A }), { box: "boxa" });
});

test("route: under All spaces with no Space named, the active server is the answer (box undefined)", () => {
  assert.deepEqual(go({ showing: "all" }), { box: undefined });
  assert.deepEqual(go({ showing: "" }), { box: undefined });
});

test("route: a Space this device does not know the server of falls to the active server", () => {
  assert.deepEqual(go({ input: { space: C } }), { box: undefined });
});

test("route: a Space whose server is no longer paired is refused naming the next step", () => {
  const r = go({ input: { space: B }, paired: ["boxa"] });
  assert.equal(r.error?.code, "server_not_paired");
  assert.match(r.error?.message ?? "", /Settings, Servers/);
});

test("route: something that is not a Space id in `space` is not looked up", () => {
  assert.deepEqual(go({ input: { space: "nope" }, showing: A }), { box: "boxa" });
});

test("spaceServersFrom: each server's own list names the Spaces it hosts; a joined team's row is not a hosted Space; the first server keeps a Space listed twice", () => {
  const m = spaceServersFrom({
    boxa: [{ id: A }, { id: C, member: true }],
    boxb: [{ id: B }, { id: A }, { id: "junk" }, null],
  });
  assert.deepEqual(m, { [A]: "boxa", [B]: "boxb" });
});

test("spaceServersFrom: a server that answered nothing is simply absent", () => {
  assert.deepEqual(spaceServersFrom({ boxa: [], boxb: /** @type {any} */ (undefined) }), {});
});

test("mergeSpaceLists: every server's Spaces in one list, each row says which server it is on, and a Space listed twice appears once", () => {
  const rows = mergeSpaceLists({
    boxa: [{ id: A, label: "personal" }, { id: C, member: true }],
    boxb: [{ id: B, label: "northwind" }, { id: A }, null],
  });
  assert.deepEqual(rows.map((r) => [r.id, r.server]), [[A, "boxa"], [C, "boxa"], [B, "boxb"]]);
  assert.equal(rows[0].label, "personal", "the row keeps what the server said");
});

test("mergeSpaceLists: a server that answered nothing adds nothing and never throws", () => {
  assert.deepEqual(mergeSpaceLists({ boxa: undefined, boxb: [] }), []);
});

// A chat always goes to the server that holds it, whatever is showing: a message for one server's chat must never land on another (its confidential material would).
const chatServers = { chat_one: "boxb", chat_two: "boxa" };

test("route: a chat goes to its own server even when the active server is another and All spaces is showing", () => {
  assert.deepEqual(go({ input: { chat: "chat_one" }, showing: "all", chatServers }), { box: "boxb" });
  assert.deepEqual(go({ input: { chat: "chat_two" }, showing: B, chatServers }), { box: "boxa" }, "the chat wins over the Space showing");
});

test("route: a chat whose server is not known is refused in words, never guessed", () => {
  const r = go({ input: { chat: "chat_unknown" }, chatServers });
  assert.equal(r.error?.code, "chat_unknown_server");
  assert.equal(r.box, undefined);
  assert.match(r.error?.message ?? "", /Chats/);
});

test("route: a chat on a server that is no longer paired is refused naming the next step", () => {
  const r = go({ input: { chat: "chat_one" }, chatServers, paired: ["boxa", "boxc"] });
  assert.equal(r.error?.code, "server_not_paired");
  assert.match(r.error?.message ?? "", /Settings, Servers/);
});

test("route: with one server paired a chat needs no map and goes where it always went", () => {
  assert.deepEqual(go({ input: { chat: "chat_unknown" }, chatServers: {}, paired: ["boxa"], spaceServers: {} }), { box: undefined });
});

test("route: a record address names its Space, so a record action goes to that Space's server under All spaces", () => {
  assert.deepEqual(go({ input: { urn: `vyre://${B}/contact/01a1` }, showing: "all" }), { box: "boxb" });
  assert.deepEqual(go({ input: { urn: `vyre://${A}/contact/01a1` }, showing: B }), { box: "boxa" }, "the address wins over the Space showing");
});

test("chatServersFrom: each server's chat list names the chats it holds; a chat listed twice stays with the first server", () => {
  const m = chatServersFrom({
    boxa: { chats: [{ chat: "c1" }, { id: "vyre://spc_aaaaaaaaaaaa/chat/c2" }] },
    boxb: { chats: [{ chat: "c3" }, { chat: "c1" }] },
  });
  assert.deepEqual(m, { c1: "boxa", c2: "boxa", c3: "boxb" });
  assert.deepEqual(chatServersFrom({ boxa: undefined, boxb: [] }), {});
});

// An action on a record, file, task, rule, flow or project belongs to ONE Space on ONE server. It goes there, whatever is showing and whichever server is active; one whose Space cannot be resolved is refused, never sent
// to the active server (a confidential record landing on the wrong server).
test("route: a record of B edited while A is showing and active reaches B only (its address names the Space)", () => {
  assert.deepEqual(go({ tool: "records.update", input: { urn: `vyre://${B}/contact/01a1`, patch: {} }, showing: A }), { box: "boxb" });
  assert.deepEqual(go({ tool: "records.reveal", input: { urn: `vyre://${B}/contact/01a1` }, showing: "all" }), { box: "boxb" });
});

test("route: a task, rule, flow, project or file action names its Space or follows the Space showing; under All spaces it is refused", () => {
  for (const tool of ["tasks.decide", "tasks.move", "rules.disable", "flows.run", "work.project.rename", "work.template.install", "files.drive.upload", "files.drive.space.read", "records.create", "records.update"]) {
    assert.deepEqual(go({ tool, input: { space: B }, showing: A }), { box: "boxb" }, `${tool} named Space wins`);
    assert.deepEqual(go({ tool, input: {}, showing: B }), { box: "boxb" }, `${tool} follows the Space showing`);
    const r = go({ tool, input: {}, showing: "all" });
    assert.equal(r.error?.code, "pick_a_space", `${tool} under All spaces`);
    assert.equal(r.box, undefined);
    assert.match(r.error?.message ?? "", /Pick the Space/);
  }
});

test("route: a Space this device does not know the server of is refused for those actions, not sent to the active server", () => {
  const r = go({ tool: "records.create", input: { space: C }, showing: "all" });
  assert.equal(r.error?.code, "space_unknown_server");
  assert.match(r.error?.message ?? "", /Settings, Servers/);
});

test("route: plain reads (lists, types, me) under All spaces still go to the active server; a Space they name wins", () => {
  for (const tool of ["records.list", "tasks.list", "records.types", "files.drive.space.list", "flows.list", "records.me"]) {
    assert.deepEqual(go({ tool, input: {}, showing: "all" }), { box: undefined }, tool);
    assert.deepEqual(go({ tool, input: { space: B }, showing: "all" }), { box: "boxb" }, `${tool} named`);
  }
});

test("route: one server paired never refuses (nothing to choose between)", () => {
  assert.deepEqual(go({ tool: "records.create", input: {}, showing: "all", paired: ["boxa"], spaceServers: {} }), { box: undefined });
});

test("needsSpace: the actions that belong to a Space, and not the reads or the tools that are the device's own", () => {
  for (const t of ["records.create", "records.update", "tasks.decide", "rules.define", "flows.run", "work.project.rename", "work.start-project", "files.drive.upload"]) assert.equal(needsSpace(t), true, t);
  for (const t of ["records.list", "tasks.list", "flows.list", "spaces.list", "projects.list", "work.chat.list", "stream.send", "records.me", "settings.get", "files.drive.list"]) assert.equal(needsSpace(t), false, t);
});

// The vault holds secrets: a team's credential must never be written to, or read from, the other server's vault. Every vault tool, reads included, needs the Space; the same goes for what else holds a Space's private data.
test("route: vault.put and vault.list reach B only when B is showing and A is active; under All spaces both are refused and nothing is sent", () => {
  for (const tool of ["vault.put", "vault.list", "vault.reveal", "vault.item", "vault.search", "vault.items.names", "vault.copy"]) {
    assert.deepEqual(go({ tool, input: {}, showing: B }), { box: "boxb" }, `${tool} follows the Space showing`);
    const r = go({ tool, input: {}, showing: "all" });
    assert.equal(r.error?.code, "pick_a_space", `${tool} under All spaces`);
    assert.equal(r.box, undefined);
  }
});

test("route: the families that hold a Space's private data are refused under All spaces; a plain list or status is not", () => {
  for (const tool of ["memory.ask", "memory.search", "agents.create", "skills.draft", "planner.add", "publish.create", "connectors.connect", "mail.compose", "mail.read", "google.api", "artifacts.create", "threads.get", "team.add", "documents.generate", "work.call"]) {
    assert.equal(needsSpace(tool), true, tool);
    assert.equal(go({ tool, input: {}, showing: "all" }).error?.code, "pick_a_space", tool);
    assert.deepEqual(go({ tool, input: {}, showing: A }), { box: "boxa" }, tool);
  }
  for (const tool of ["memory.backup.status", "agents.list", "skills.list", "planner.agenda", "connectors.catalog", "mail.accounts", "google.accounts", "artifacts.list"]) assert.equal(go({ tool, input: {}, showing: "all" }).error, undefined, `${tool} is not refused`);
});

test("route: server settings follow the Space showing but are not refused under All spaces; the device's own tools are never routed", () => {
  for (const tool of ["settings.get", "appearance.presets", "spend.summary", "update.status"]) {
    assert.equal(needsSpace(tool), false, tool);
    assert.deepEqual(go({ tool, input: {}, showing: "all" }), { box: undefined }, tool);
  }
});
