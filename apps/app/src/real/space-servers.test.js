// @ts-check
// Two servers paired, the active one is A, All spaces showing: a chat that belongs to B is sent to B and only B, a chat whose server cannot be found is refused and sent nowhere, and a server being offline
// loses nobody else's chats (space-servers.ts over fake pairings and a fake wire).
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const load = () => import("./space-servers.ts");

/** A wire with the chats each server holds; every call is recorded as [box, tool]. */
function wire(/** @type {Record<string, string[]>} */ chats, /** @type {string[]} */ down = []) {
  /** @type {Array<[string | undefined, string, any]>} */ const sent = [];
  return {
    sent,
    ports: {
      listPairings: async () => [{ box: "boxa" }, { box: "boxb" }],
      subscribePairings: () => () => {},
      peerCall: async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string | undefined} */ box) => {
        sent.push([box, tool, input]);
        if (box && down.includes(box)) throw Object.assign(new Error("down"), { code: "unreachable" });
        if (tool === "work.chat.list") return { chats: (chats[/** @type {string} */ (box)] ?? []).map((c) => ({ chat: c })) };
        if (tool === "spaces.list") return [];
        return { ok: true };
      },
    },
  };
}

test("a chat that belongs to B is sent to B only, under All spaces, with A the active server", { skip: !strip }, async () => {
  const m = await load();
  const w = wire({ boxa: ["chat_a"], boxb: ["chat_b"] });
  m.setPorts(/** @type {any} */ (w.ports));
  const route = await m.routeCall({ input: { chat: "chat_b", text: "confidential" }, showing: "all" });
  assert.deepEqual(route, { box: "boxb" });
  await w.ports.peerCall("stream.send", { chat: "chat_b", text: "confidential" }, route.box);
  const sends = w.sent.filter((x) => x[1] === "stream.send");
  assert.deepEqual(sends.map((x) => x[0]), ["boxb"], "reached B only");
  assert.ok(!w.sent.some((x) => x[0] === "boxa" && x[1] === "stream.send"), "never A");
  m.setPorts(null);
});

test("a record of B edited while A is active reaches B only; creating with no Space showing asks which Space and sends nothing", { skip: !strip }, async () => {
  const m = await load();
  const w = wire({});
  m.setPorts(/** @type {any} */ ({ ...w.ports, peerCall: async (/** @type {string} */ t, /** @type {any} */ i, /** @type {string | undefined} */ b) => { if (t === "spaces.list") return b === "boxa" ? [{ id: "spc_aaaaaaaaaaaa" }] : [{ id: "spc_bbbbbbbbbbbb" }]; return w.ports.peerCall(t, i, b); } }));
  const edit = await m.routeCall({ tool: "records.update", input: { urn: "vyre://spc_bbbbbbbbbbbb/contact/01a1", patch: { name: "x" } }, showing: "spc_aaaaaaaaaaaa" });
  assert.deepEqual(edit, { box: "boxb" });
  await w.ports.peerCall("records.update", { urn: "vyre://spc_bbbbbbbbbbbb/contact/01a1" }, edit.box);
  assert.deepEqual(w.sent.filter((x) => x[1] === "records.update").map((x) => x[0]), ["boxb"], "reached B only");
  const create = await m.routeCall({ tool: "records.create", input: { type: "contact" }, showing: "all" });
  assert.equal(create.error?.code, "pick_a_space");
  assert.ok(!w.sent.some((x) => x[1] === "records.create"), "nothing was sent");
  m.setPorts(null);
});

test("two servers, A active and B showing: vault.put and vault.list reach B only; under All spaces they are refused and nothing is sent", { skip: !strip }, async () => {
  const m = await load();
  const w = wire({});
  m.setPorts(/** @type {any} */ ({ ...w.ports, peerCall: async (/** @type {string} */ t, /** @type {any} */ i, /** @type {string | undefined} */ b) => { if (t === "spaces.list") return b === "boxa" ? [{ id: "spc_aaaaaaaaaaaa" }] : [{ id: "spc_bbbbbbbbbbbb" }]; return w.ports.peerCall(t, i, b); } }));
  for (const tool of ["vault.put", "vault.list"]) {
    const route = await m.routeCall({ tool, input: {}, showing: "spc_bbbbbbbbbbbb" });
    assert.deepEqual(route, { box: "boxb" }, tool);
    await w.ports.peerCall(tool, {}, route.box);
  }
  assert.deepEqual(w.sent.filter((x) => x[1].startsWith("vault.")).map((x) => x[0]), ["boxb", "boxb"], "B only, never A");
  for (const tool of ["vault.put", "vault.list"]) assert.equal((await m.routeCall({ tool, input: {}, showing: "all" })).error?.code, "pick_a_space", tool);
  assert.equal(w.sent.filter((x) => x[1].startsWith("vault.")).length, 2, "nothing was sent under All spaces");
  m.setPorts(null);
});

test("a task listed from B, decided while A is showing and active, reaches B only", { skip: !strip }, async () => {
  const m = await load();
  const w = wire({});
  m.setPorts(/** @type {any} */ ({ ...w.ports, peerCall: async (/** @type {string} */ t, /** @type {any} */ i, /** @type {string | undefined} */ b) => { if (t === "spaces.list") return b === "boxa" ? [{ id: "spc_aaaaaaaaaaaa" }] : [{ id: "spc_bbbbbbbbbbbb" }]; return w.ports.peerCall(t, i, b); } }));
  // B's Space is showing and its tasks are listed: the ids are remembered with B's Space
  m.noteItems({ tasks: [{ id: "tsk_b1" }] }, "spc_bbbbbbbbbbbb");
  // now A is showing: the id-only decide still goes to B, told B's Space
  const route = await m.routeCall({ tool: "tasks.decide", input: { id: "tsk_b1" }, showing: "spc_aaaaaaaaaaaa" });
  assert.deepEqual(route, { box: "boxb", space: "spc_bbbbbbbbbbbb" });
  await w.ports.peerCall("tasks.decide", { id: "tsk_b1", space: route.space }, route.box);
  assert.deepEqual(w.sent.filter((x) => x[1] === "tasks.decide").map((x) => [x[0], x[2].space]), [["boxb", "spc_bbbbbbbbbbbb"]], "B only, with B's Space");
  const unseen = await m.routeCall({ tool: "tasks.decide", input: { id: "tsk_nobody" }, showing: "spc_aaaaaaaaaaaa" });
  assert.equal(unseen.error?.code, "item_unknown_server");
  assert.equal(w.sent.filter((x) => x[1] === "tasks.decide").length, 1, "the unknown id sent nothing");
  m.setPorts(null);
});

test("a chat nobody holds is refused in words and nothing is sent to any server", { skip: !strip }, async () => {
  const m = await load();
  const w = wire({ boxa: ["chat_a"], boxb: ["chat_b"] });
  m.setPorts(/** @type {any} */ (w.ports));
  const route = await m.routeCall({ input: { chat: "chat_zzz" }, showing: "all" });
  assert.equal(route.error?.code, "chat_unknown_server");
  assert.equal(route.box, undefined);
  assert.ok(!w.sent.some((x) => x[1] === "stream.send"), "nothing was sent");
  m.setPorts(null);
});

test("with B offline, A's chats still resolve and B's chat is refused rather than sent to A", { skip: !strip }, async () => {
  const m = await load();
  const w = wire({ boxa: ["chat_a"], boxb: ["chat_b"] }, ["boxb"]);
  m.setPorts(/** @type {any} */ (w.ports));
  assert.deepEqual(await m.routeCall({ input: { chat: "chat_a" }, showing: "all" }), { box: "boxa" });
  const b = await m.routeCall({ input: { chat: "chat_b" }, showing: "all" });
  assert.equal(b.error?.code, "chat_unknown_server");
  m.setPorts(null);
});

test("a chat just made on a server is known to be there without asking", { skip: !strip }, async () => {
  const m = await load();
  const w = wire({});
  m.setPorts(/** @type {any} */ (w.ports));
  m.noteChat("chat_new", "boxb");
  assert.deepEqual(await m.routeCall({ input: { chat: "chat_new" }, showing: "all" }), { box: "boxb" });
  m.setPorts(null);
});

test("every send path in tool() hands the routed server to the wire, and the chat stream follows its chat's server", () => {
  const box = fs.readFileSync(new URL("./box.ts", import.meta.url), "utf8");
  assert.match(box, /peerCall<T>\(name, input, to\)/);
  assert.match(box, /\(approval\) => peerCall<T>\(name, \{ \.\.\.input, approval \}, to\)/);
  const stream = fs.readFileSync(new URL("../chat/box-stream.ts", import.meta.url), "utf8");
  assert.match(stream, /routeCall\(\{ input: \{ chat: session \}/);
  assert.match(stream, /peerDuplex\(session, from, route\.box\)/);
});
