// @ts-check
// vault.me.provisioned: the accounts the firm key lets a member act as (her own Google mailbox, calendar and Drive), listed beside her connections so she can see what is hers. Names and addresses only: nothing
// is stored, there is no token, and the owner's own accounts and other members' are never in her list.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "./provisioned.js";

const BOB = "per_bob", OWNER = "per_owner";

function rig(accounts, microsoft) {
  const reg = /** @type {Map<string, any>} */ (new Map());
  const calls = /** @type {any[]} */ ([]);
  const ctx = { kernel: { owner: OWNER, chain: async (/** @type {any} */ m) => ({ hops: m.hops || [] }) }, call: async (/** @type {string} */ t, /** @type {any} */ i) => { calls.push([t, i]); return t === "google.accounts" ? accounts : t === "microsoft.accounts" ? (microsoft || { data: [] }) : { error: { code: "no_such_tool" } }; } };
  register({ ctx, tool: (n, callers, d, i, run) => reg.set(n, { callers, run }) });
  const as = (/** @type {string | null} */ who, extra = {}) => reg.get("vault.me.provisioned").run({}, { caller: "device:abcdefghijklmnop", hops: who ? [{ actor: { kind: "person", id: who } }] : [], ...extra });
  return { as, calls, reg };
}

test("a member sees the Google account the firm key lets her act as: address and name, no token, nothing else", async () => {
  const { as, calls } = rig({ data: [{ name: "firm-m1a2b3c4", email: "bob@juniperstudio.example.com", member: BOB, auth: { type: "service-account", item: "firm-key", subject: "bob@juniperstudio.example.com" } }] });
  const r = await as(BOB);
  assert.deepEqual(r.accounts, [{ app: "Google Workspace", account: "bob@juniperstudio.example.com" }]);
  assert.ok(!JSON.stringify(r).includes("firm-key"), "not the item that authenticates it");
  assert.equal(calls[0][0], "google.accounts");
});

test("an empty list when the firm has no key for her; the owner and an assistant are refused; a model or another surface cannot ask", async () => {
  assert.deepEqual((await rig({ data: [] }).as(BOB)).accounts, []);
  assert.deepEqual((await rig({ error: { code: "no_account" } }).as(BOB)).accounts, [], "no firm key for her is not an error");
  await assert.rejects(rig({ data: [] }).as(OWNER), /member's own vault|denied/);
  await assert.rejects(rig({ data: [] }).as(BOB, { hops: [{ actor: { kind: "person", id: BOB } }, { actor: { kind: "agent", id: "kit" } }] }), /member's own vault|denied/);
  for (const c of ["module", "mcp", "harness", "tailnet"]) assert.ok(!rig({ data: [] }).reg.get("vault.me.provisioned").callers.includes(c), c);
});

test("two members each see only their own address, and the firm key's own account is never listed", async () => {
  const all = { data: [
    { name: "firm-m1", email: "bob@juniperstudio.example.com", member: BOB },
    { name: "firm-m2", email: "eve@juniperstudio.example.com", member: "per_eve" },
    { name: "firm", email: "owner@juniperstudio.example.com", firm: true },
  ] };
  assert.deepEqual((await rig(all).as(BOB)).accounts.map((/** @type {any} */ a) => a.account), ["bob@juniperstudio.example.com"]);
  assert.deepEqual((await rig(all).as("per_eve")).accounts.map((/** @type {any} */ a) => a.account), ["eve@juniperstudio.example.com"]);
});

test("her Microsoft 365 account is listed too, from the firm app's own answer for her: the address and the app, nothing else", async () => {
  const r = await rig({ data: [] }, { data: [{ app: "Juniper firm app", email: "bob@juniperstudio.example.com", domain: "juniperstudio.example.com" }] }).as(BOB);
  assert.deepEqual(r.accounts, [{ app: "Microsoft 365", account: "bob@juniperstudio.example.com" }], "the firm app's name and its domain are not shown");
  const both = await rig({ data: [{ name: "firm-m1", email: "bob@juniperstudio.example.com", member: BOB }] }, { data: [{ app: "Juniper firm app", email: "bob@juniperstudio.example.com" }] }).as(BOB);
  assert.deepEqual(both.accounts.map((/** @type {any} */ a) => a.app).sort(), ["Google Workspace", "Microsoft 365"]);
  assert.deepEqual((await rig({ data: [] }, { error: { code: "no_account" } }).as(BOB)).accounts, [], "no firm app for her is not an error");
});
