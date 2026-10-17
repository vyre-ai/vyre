// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInviteLink, inviteSpaceHint, daemonJoinLink, publicInviteLink } from "./invite-link.js";

const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const CHAIN = `spc_${"b".repeat(26)}`;
const kernel = `inv_${"cd".repeat(16)}.${b64({ chain: { id: CHAIN, seq: 2, head: "h" }, rk: "rk" })}`;
const signed = `${b64({ v: 1, id: "inv_x", space: "harlow", sid: "spc_s", iat: 1, ttl: 5 })}.${Buffer.alloc(64).toString("base64url")}`;

test("a token says which space it is for: a name when the space's root key signed it, a chain id when it is a kernel token", () => {
  assert.deepEqual(inviteSpaceHint(kernel), { chain: CHAIN });
  assert.deepEqual(inviteSpaceHint(signed), { name: "harlow" });
  assert.deepEqual(inviteSpaceHint(`${b64({ space: "Harlow.vyre.run" })}.sig`), { name: "harlow" });
  for (const bad of ["", "abcdefghij", "a.b", `${b64({ space: "no spaces allowed" })}.sig`, `${b64({ space: 7 })}.sig`, `${b64({})}.sig`, `inv_${"cd".repeat(16)}.${b64({ chain: {} })}`]) assert.equal(inviteSpaceHint(bad), null, bad);
});

test("the space's own join link goes through untouched and asks nothing; the link to share becomes one for the space its token names", async () => {
  const asked = [];
  const lookupSpace = async (/** @type {string} */ id) => { asked.push(id); return id === CHAIN ? { kind: "space", id, name: "harlow" } : null; };
  assert.equal(await resolveInviteLink(`https://harlow.vyre.run/join/${kernel}`, { lookupSpace }), `https://harlow.vyre.run/join/${kernel}`);
  assert.deepEqual(asked, []);
  assert.equal(await resolveInviteLink(publicInviteLink(kernel), { lookupSpace }), `https://harlow.vyre.run/join/${kernel}`);
  assert.deepEqual(asked, [CHAIN]);
  assert.equal(await resolveInviteLink(publicInviteLink(signed), { lookupSpace }), `https://harlow.vyre.run/join/${signed}`);
  assert.deepEqual(asked, [CHAIN], "a token that names its space asks nobody");
});

test("a link that cannot be matched to a space is refused in plain words with a code, and a directory that is down is not the same as one that has no such space", async () => {
  const rows = { person: { kind: "person", id: CHAIN, name: "harlow" }, other: { kind: "space", id: "spc_other", name: "harlow" }, badname: { kind: "space", id: CHAIN, name: "Bad Name!" } };
  for (const [what, found] of Object.entries(rows)) {
    await assert.rejects(() => resolveInviteLink(publicInviteLink(kernel), { lookupSpace: async () => found }), (e) => e.code === "not_found" && /could not be matched/.test(e.message), what);
  }
  await assert.rejects(() => resolveInviteLink(publicInviteLink(kernel), { lookupSpace: async () => null }), (e) => e.code === "not_found");
  await assert.rejects(() => resolveInviteLink(publicInviteLink(kernel), { lookupSpace: async () => { throw Object.assign(new Error("no"), { code: "not_found" }); } }), (e) => e.code === "not_found");
  await assert.rejects(() => resolveInviteLink(publicInviteLink(kernel), { lookupSpace: async () => { throw new Error("socket hang up"); } }), (e) => e.code === "unreachable" && /Cannot reach/.test(e.message));
  await assert.rejects(() => resolveInviteLink("https://vyre.run/i/abcdefghij", { lookupSpace: async () => null }), (e) => e.code === "bad_input" && /does not say which space/.test(e.message));
  for (const link of ["", "not a link", "https://evil.example/join/abcdefgh.ijklmnop", "https://vyre.run/x/abcdefghij"]) {
    await assert.rejects(() => resolveInviteLink(link, { lookupSpace: async () => null }), (e) => e.code === "bad_input" && /does not open a space/.test(e.message), link);
  }
});

test("the daemon's side finds the space among the ones it holds first, then the directory, and passes every other host through", async () => {
  const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
  const asked = [];
  const d = { spaces: { all: () => [{ id: "spc_one", name: "harlow.vyre.run" }, { id: "spc_two", name: "northwind.vyre.run" }] }, chainOf: (/** @type {string} */ id) => (id === "spc_two" ? { pin: { id: CHAIN } } : null),
    dir: { spaceByChain: async (/** @type {string} */ id) => { asked.push(id); if (id === `spc_${"c".repeat(26)}`) return { kind: "space", id, name: "remote" }; throw Object.assign(new Error("none"), { code: "not_found" }); } }, refuse };
  assert.equal(await daemonJoinLink(publicInviteLink(kernel), d), `https://northwind.vyre.run/join/${kernel}`, "a space this device holds");
  assert.deepEqual(asked, []);
  const far = `inv_${"cd".repeat(16)}.${b64({ chain: { id: `spc_${"c".repeat(26)}`, seq: 1, head: "h" } })}`;
  assert.equal(await daemonJoinLink(publicInviteLink(far), d), `https://remote.vyre.run/join/${far}`, "found in the directory");
  assert.equal(await daemonJoinLink(`https://app.harlow.example.com/join/${kernel}`, d), `https://app.harlow.example.com/join/${kernel}`, "an own-domain link is the caller's to resolve");
  assert.equal(await daemonJoinLink("not a link", d), "not a link");
  await assert.rejects(() => daemonJoinLink(publicInviteLink(`inv_${"cd".repeat(16)}.${b64({ chain: { id: `spc_${"d".repeat(26)}`, seq: 1, head: "h" } })}`), d), (e) => e.code === "not_found" && /could not be matched/.test(e.message));
});
