// @ts-check
// Which server a call goes to (server-route.js): the one named, else the one that hosts the Space the call is for or the Space showing, else the active one. A server this device is not paired to is refused
// with a next step and never answered by another server.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSpaceLists, serverFor, spaceServersFrom } from "./server-route.js";

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
