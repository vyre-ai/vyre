// @ts-check
// Which server a call goes to (server-route.js): the one named, else the one that hosts the Space the call is for or the Space showing, else the active one. A server this device is not paired to is refused
// with a next step and never answered by another server.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalServersFrom, chatServersFrom, itemSpacesFrom, mergeSpaceLists, needsSpace, serverFor, spaceServersFrom } from "./server-route.js";

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
  for (const t of ["records.list", "tasks.list", "flows.list", "spaces.list", "projects.list", "work.chat.list", "records.me", "settings.get", "files.drive.list"]) assert.equal(needsSpace(t), false, t);
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
  for (const tool of ["settings.get", "appearance.presets", "sidebar.get"]) {
    assert.equal(needsSpace(tool), false, tool);
    assert.deepEqual(go({ tool, input: {}, showing: "all" }), { box: undefined }, tool);
  }
});

// The default is safe: a family nobody classified is routed and refused under All spaces; only an explicit allow-list is left alone.
test("route: a family nobody classified (and any future one) is routed and refused under All spaces", () => {
  for (const tool of ["chrome.act", "computers.checkout", "runner.lock", "previews.get", "glass.close", "ask.get", "hooks.open", "harness.brief", "sight.watch", "hands.act", "screen.shot", "import.start", "models.get", "pluginagent.ask", "outside.grant", "undo.run", "views.act", "vitals.advice", "voice.speak", "waiting.count", "zzz.future-thing"]) {
    assert.equal(needsSpace(tool), true, tool);
    assert.equal(go({ tool, input: {}, showing: "all" }).error?.code, "pick_a_space", tool);
    assert.deepEqual(go({ tool, input: {}, showing: B }), { box: "boxb" }, `${tool} follows the Space showing`);
  }
});

test("route: only the explicit allow-list (the device's own and the server's own settings) is never refused", () => {
  for (const tool of ["relay.devices.revoke", "wink.pair.server", "presence.person.start-paired", "identity.status", "spaces.create", "spaces.members.add", "push.subscribe", "push.devices", "names.check", "settings.get", "appearance.resolve", "sidebar.edit", "about.text", "tips.dismiss", "presence.person.start-paired", "presence.person.status"]) {
    assert.equal(needsSpace(tool), false, tool);
    assert.equal(go({ tool, input: {}, showing: "all" }).error, undefined, tool);
  }
});

// An action that names only an id (a task, a rule, a project) goes to the Space the id was seen in, whatever is showing; an id never seen is refused when several servers are paired.
const itemSpaces = { tsk_b1: B, tsk_a1: A };

test("route: a task of B decided while A is showing reaches B, and the call is told B's Space", () => {
  assert.deepEqual(go({ tool: "tasks.decide", input: { id: "tsk_b1" }, itemSpaces, showing: A }), { box: "boxb", space: B });
  assert.deepEqual(go({ tool: "tasks.move", input: { id: "tsk_a1" }, itemSpaces, showing: B }), { box: "boxa", space: A });
  assert.deepEqual(go({ tool: "tasks.get", input: { id: "tsk_b1" }, itemSpaces, showing: "all" }), { box: "boxb", space: B }, "under All too");
});

test("route: an id never seen is refused with several servers, even when a Space is showing", () => {
  const r = go({ tool: "tasks.decide", input: { id: "tsk_zzz" }, itemSpaces, showing: A });
  assert.equal(r.error?.code, "item_unknown_server");
  assert.equal(r.box, undefined);
  assert.match(r.error?.message ?? "", /Open the Space/);
});

test("route: a Space the screen names outright wins over the id's; one server paired never refuses", () => {
  assert.deepEqual(go({ tool: "tasks.decide", input: { id: "tsk_b1", space: A }, itemSpaces, showing: B }), { box: "boxa" });
  assert.deepEqual(go({ tool: "tasks.decide", input: { id: "tsk_zzz" }, itemSpaces: {}, showing: A, paired: ["boxa"], spaceServers: {} }), { box: undefined });
});

test("itemSpacesFrom: the ids a list shows are remembered with the Space they were in (the row's address, its own space, else the Space asked for)", () => {
  const m = itemSpacesFrom({ tasks: [{ id: "t1", space: B }, { id: "t2" }, { urn: `vyre://${A}/task/t3` }, null, { id: 7 }] }, C);
  assert.deepEqual(m, { t1: B, t2: C, t3: A });
  assert.deepEqual(itemSpacesFrom([{ id: "r1", slug: "proj-one" }], B), { r1: B, "proj-one": B });
  assert.deepEqual(itemSpacesFrom({ id: "new1" }, A), { new1: A }, "a thing just made");
  assert.deepEqual(itemSpacesFrom([{ id: "x" }], undefined), {}, "no Space known, nothing remembered");
  assert.deepEqual(itemSpacesFrom("junk", A), {});
});

// What a server owns by itself (its updates, restarts, setup, sign-ins, spending, providers) is never done to the active server by default: it follows the Space showing, and under All spaces with several servers it is refused.
test("route: update, system, onboard, person sign-ins, spend and providers follow the Space showing and are refused under All spaces", () => {
  for (const tool of ["update.apply", "update.check", "system.rename", "system.info", "system.modules", "onboard.finish", "onboard.you", "onboard.claude", "presence.person.start", "presence.person.sessions", "presence.person.revoke", "spend.summary", "spend.raise", "spend.check", "providers.refresh"]) {
    assert.equal(needsSpace(tool), true, tool);
    assert.deepEqual(go({ tool, input: {}, showing: B }), { box: "boxb" }, `${tool} goes to the server of the Space showing`);
    assert.equal(go({ tool, input: {}, showing: "all" }).error?.code, "pick_a_space", `${tool} is never the active server by default`);
  }
  for (const tool of ["events.catalog", "providers.list", "update.status"]) assert.equal(go({ tool, input: {}, showing: "all" }).error, undefined, `${tool} is a plain read`);
});

// An approval is judged on the server that holds the held act, whichever server is active.
const approvalServers = { appr_b1: "boxb", appr_a1: "boxa" };

test("route: an approval answered, edited or opened goes to the server that holds the act", () => {
  for (const tool of ["approvals.answer", "approvals.edit-item", "approvals.item-view", "approvals.status", "approvals.local-yes"]) {
    assert.deepEqual(go({ tool, input: { id: "appr_b1" }, approvalServers, showing: A }), { box: "boxb" }, tool);
  }
  assert.deepEqual(go({ tool: "approvals.answer-group", input: { group: "g", decisions: [{ id: "appr_b1", approve: true }, { id: "appr_b1", approve: false }] }, approvalServers, showing: A }), { box: "boxb" });
});

test("route: an approval whose server is unknown, or a group that spans two servers, is refused and nothing is sent", () => {
  const unknown = go({ tool: "approvals.answer", input: { id: "appr_zzz" }, approvalServers, showing: A });
  assert.equal(unknown.error?.code, "approval_unknown_server");
  assert.match(unknown.error?.message ?? "", /Approvals/);
  const mixed = go({ tool: "approvals.answer-group", input: { decisions: [{ id: "appr_b1" }, { id: "appr_a1" }] }, approvalServers, showing: A });
  assert.equal(mixed.error?.code, "approval_mixed_servers");
  assert.equal(mixed.box, undefined);
});

test("route: one server paired never refuses an approval", () => {
  assert.deepEqual(go({ tool: "approvals.answer", input: { id: "appr_zzz" }, approvalServers: {}, paired: ["boxa"], spaceServers: {} }), { box: undefined });
});

test("approvalServersFrom: the held acts each server lists, by id, the first server keeping an id listed twice", () => {
  assert.deepEqual(approvalServersFrom({ boxa: [{ id: "x1" }, { id: "x2" }], boxb: [{ id: "y1" }, { id: "x1" }, null, { id: 3 }] }), { x1: "boxa", x2: "boxa", y1: "boxb" });
  assert.deepEqual(approvalServersFrom({ boxa: undefined, boxb: "junk" }), {});
});
