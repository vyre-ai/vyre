// @ts-check
// The space vault tools through their real definitions: who the key is shared with, and where an agent may send a stored secret.
// The tool table is the one registerSpaceTools fills; the kernel is a stand-in that answers membership.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { x25519Pair } from "../../kernel/identity/wrap.js";
import { registerSpaceTools } from "./space-tools.js";
import { noteFirstAdopt, FIRST_ADOPT_MS } from "../../lib/first-adopt.js";

const SPACE = "spc_aaaaaaaaaa";
const ALICE = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "per_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const STRANGER = "per_cccccccccccccccccccccccccc";
const SECRET = "vyre-space-secret-5d1e8b";

/** @param {{ members?: string[], owner?: string, noKernel?: boolean, fetch?: any }} [o] */
function rig(o = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sp-"));
  /** @type {Map<string, any>} */ const tools = new Map();
  const members = new Set(o.members || []);
  const events = /** @type {any[]} */ ([]);
  const logs = /** @type {string[]} */ ([]);
  const ctx = {
    paths: { root }, log: (/** @type {string} */ m) => { logs.push(String(m)); }, events: { emit: (/** @type {string} */ t, /** @type {any} */ p) => { events.push([t, p]); } },
    tool: (/** @type {string} */ name, /** @type {any} */ def) => tools.set(name, def),
    ...(o.noKernel ? {} : { kernel: { space: SPACE, owner: o.owner, membership: async (/** @type {string} */ person, /** @type {string} */ space) => ({ member: space === SPACE && members.has(person) }) } }),
  };
  registerSpaceTools(ctx, o.fetch ? { fetch: o.fetch } : {});
  const call = (/** @type {string} */ name, /** @type {any} */ input, caller = "cli") => tools.get(name).run(input, { caller });
  return { call, tools, events, logs, root };
}

test("the space vault key is shared only with a member of that space, and only one key per member", async () => {
  const r = rig({ members: [ALICE] });
  await r.call("vault.space.create", { space: SPACE });
  const alice = x25519Pair();
  const granted = await r.call("vault.space.grant", { space: SPACE, person: ALICE, pub: alice.pub });
  assert.equal(granted.person, ALICE);
  await assert.rejects(() => r.call("vault.space.grant", { space: SPACE, person: STRANGER, pub: x25519Pair().pub }), (/** @type {any} */ e) => e.code === "denied" && /not a member/.test(e.message));
  const status = await r.call("vault.space.status", { space: SPACE });
  assert.deepEqual(status.members, [ALICE], "the stranger got no wrap");
  // A second, different key for a member who already has one is a swap, not a grant.
  await assert.rejects(() => r.call("vault.space.grant", { space: SPACE, person: ALICE, pub: x25519Pair().pub }), (/** @type {any} */ e) => e.code === "exists");
  await r.call("vault.space.grant", { space: SPACE, person: ALICE, pub: alice.pub });
  // A public key that is not a 32-byte key is refused before anything is wrapped.
  await assert.rejects(() => r.call("vault.space.grant", { space: SPACE, person: ALICE, pub: "short" }), (/** @type {any} */ e) => e.code === "bad_input");
});

test("the space vault key is not shared when the kernel cannot say who belongs", async () => {
  const r = rig({ noKernel: true });
  await r.call("vault.space.create", { space: SPACE });
  await assert.rejects(() => r.call("vault.space.grant", { space: SPACE, person: BOB, pub: x25519Pair().pub }), (/** @type {any} */ e) => e.code === "unavailable");
  assert.deepEqual((await r.call("vault.space.status", { space: SPACE })).members, []);
});

test("the home space's owner is a member of the home space without a membership row", async () => {
  const r = rig({ owner: ALICE });
  await r.call("vault.space.create", { space: SPACE });
  const granted = await r.call("vault.space.grant", { space: SPACE, person: ALICE, pub: x25519Pair().pub });
  assert.equal(granted.person, ALICE);
});

test("an item is stored for its hosts, and use refuses any other host before a request leaves", async () => {
  const r = rig();
  await r.call("vault.space.create", { space: SPACE });
  await assert.rejects(() => r.call("vault.space.put", { space: SPACE, id: "stripe", name: "Stripe", value: SECRET }), (/** @type {any} */ e) => e.code === "host_refused");
  await r.call("vault.space.put", { space: SPACE, id: "stripe", name: "Stripe", value: SECRET, hosts: ["api.example.com"] });
  const elsewhere = ["https://evil.example/steal", "https://api.example.com.evil.example/x", "http://api.example.com/x", "https://user:pw@api.example.com/x", "https://api.example.com:8443/x", "https://169.254.169.254/latest"];
  for (const url of elsewhere) {
    for (const caller of ["cli", "mcp", "harness", "mcp:agent:kit"]) {
      await assert.rejects(() => r.call("vault.space.use", { space: SPACE, id: "stripe", url }, caller), (/** @type {any} */ e) => e.code === "host_refused" || e.code === "bad_input", `${caller} ${url}`);
    }
  }
});

test("a lent value never reaches the response, the audit line, the log or an error, and every use is audited with the agent, the item and the host", async () => {
  /** @type {any[]} */ const sent = [];
  const echo = async (/** @type {string} */ url, /** @type {any} */ init) => {
    sent.push({ url, init });
    if (/boom/.test(url)) throw Object.assign(new Error(`connect failed with Authorization: ${init.headers.authorization}`), { code: "network" });
    return { status: 200, headers: { get: () => "" }, text: async () => `you sent ${init.headers.authorization} and ${JSON.stringify(init.headers)}` };
  };
  const r = rig({ fetch: echo });
  await r.call("vault.space.create", { space: SPACE });
  await r.call("vault.space.put", { space: SPACE, id: "stripe", name: "Stripe", value: SECRET, hosts: ["api.example.com"] });
  const ok = await r.call("vault.space.use", { space: SPACE, id: "stripe", url: "https://api.example.com/v1/balance" }, "mcp:agent:kit");
  assert.equal(sent[0].init.headers.authorization, `Bearer ${SECRET}`, "the value did go out on the request");
  assert.equal(JSON.stringify(ok).includes(SECRET), false, "and never came back");
  await assert.rejects(() => r.call("vault.space.use", { space: SPACE, id: "stripe", url: "https://api.example.com/boom" }, "mcp:agent:kit"), (/** @type {any} */ e) => !e.message.includes(SECRET) && e.code === "network");
  await assert.rejects(() => r.call("vault.space.use", { space: SPACE, id: "stripe", url: "https://evil.example/x" }, "mcp:agent:kit"), (/** @type {any} */ e) => e.code === "host_refused");
  const used = r.events.filter(e => e[0] === "vault.space-used");
  assert.equal(used.length, 3, "a use, a failed use and a refused one are each audited");
  assert.deepEqual(used[0][1], { space: SPACE, item: "Stripe", host: "api.example.com", by: "mcp:agent:kit", ok: true, status: 200 });
  assert.equal(used[1][1].ok, false);
  assert.equal(used[2][1].host, "evil.example");
  assert.equal(JSON.stringify(r.events).includes(SECRET), false, "no event carries the value");
  assert.equal(r.logs.join("\n").includes(SECRET), false, "no log line carries the value");
});

const ADOPTER = "device:adopter1";
/** Does the registry ask this caller for a fresh approval before vault.space.create? (The tool's own `when`, as presence.required calls it.) */
const asks = (/** @type {any} */ r, /** @type {string} */ caller, /** @type {string} */ space = SPACE, /** @type {any} */ meta = {}) => Boolean(r.tools.get("vault.space.create").presence.when({ space }, { caller, meta }));

test("the device that finished the first adoption makes this server's space vault without a fresh approval, once, and nothing else is opened up", async () => {
  const r = rig();
  noteFirstAdopt(r.root, ADOPTER, Date.now() - 1000);
  assert.equal(asks(r, ADOPTER), false, "the adopter, inside the window, for this server's own space, with no vault yet");
  const made = await r.call("vault.space.create", { space: SPACE }, ADOPTER);
  assert.equal(made.generation, 1);
  assert.deepEqual(r.events.find((e) => e[0] === "vault.space-created")?.[1], { space: SPACE, device: ADOPTER, firstRun: true });
  assert.ok(r.logs.some((l) => /space vault made for/.test(l) && !/key/i.test(l)), "an audit line, no key material");
  assert.deepEqual((await r.call("vault.space.status", { space: SPACE })).members, [], "the new vault has no member grant");
  // A second call needs the approval again, and the tool itself refuses a vault that is already there.
  assert.equal(asks(r, ADOPTER), true);
  await assert.rejects(() => r.call("vault.space.create", { space: SPACE }, ADOPTER), (/** @type {any} */ e) => e.code === "exists");
  // Putting, granting and rotating are never narrowed: they declare presence with no `when`.
  for (const n of ["vault.space.put", "vault.space.grant", "vault.space.rotate"]) {
    const p = r.tools.get(n).presence;
    assert.ok(p && typeof p.when !== "function", `${n} always asks`);
  }
});

test("the exemption holds only inside its bounds: late, another device, an agent or MCP caller, another space, no record of an adoption", async () => {
  const late = rig();
  noteFirstAdopt(late.root, ADOPTER, Date.now() - FIRST_ADOPT_MS - 5000);
  assert.equal(asks(late, ADOPTER), true, "after ten minutes");

  const r = rig();
  noteFirstAdopt(r.root, ADOPTER, Date.now() - 1000);
  assert.equal(asks(r, "device:someoneelse"), true, "another paired device");
  assert.equal(asks(r, "cli"), true, "a local caller is not the adopter");
  assert.equal(asks(r, "mcp:agent:kit"), true, "an agent");
  assert.equal(asks(r, "mcp"), true, "an MCP caller");
  assert.equal(asks(r, ADOPTER, SPACE, { agent: "kit" }), true, "the adopter's device acting for an agent");
  assert.equal(asks(r, ADOPTER, "spc_bbbbbbbbbb"), true, "a space that is not this server's own");
  assert.equal(asks(r, ADOPTER, "not-a-space"), true, "an id that is not a space id");
  assert.equal(Boolean(r.tools.get("vault.space.create").presence.when({ space: SPACE })), true, "a caller the registry did not name");

  const none = rig();
  assert.equal(asks(none, ADOPTER), true, "no first adoption is on record");
  const noKernel = rig({ noKernel: true });
  noteFirstAdopt(noKernel.root, ADOPTER, Date.now() - 1000);
  assert.equal(asks(noKernel, ADOPTER), true, "a server that cannot say which space is its own");
});
