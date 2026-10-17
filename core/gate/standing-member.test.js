// @ts-check
// Standing permissions and a member's agent (0.6): the owner's standing permission for an agent does NOT cover that agent's send in a member's turn. The send is the member's own item, held for them, because
// the permission was given about the owner's mail connection and the member cannot use it. Through the real Gate on a real vyred with the kernel on; only the outside mail server is a fake.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { canonical } from "../../kernel/core/canonical.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const stubPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const proofFor = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: crypto.createHash("sha256").update(canonical({ action, input })).digest("hex") }, n: Math.random() });
void proofFor;

async function fakeGmail(/** @type {import("node:test").TestContext} */ t) {
  /** @type {any[]} */ const got = [];
  const server = http.createServer((req, res) => { let body = ""; req.on("data", d => (body += d)); req.on("end", () => { got.push({ url: req.url, body }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m1", threadId: "t1" })); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}


test("the owner's standing permission for an agent covers the agent's send for the owner, and not the same agent's send in a member's turn, which is held for the member", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const gmail = await fakeGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const tokenOf = async (/** @type {any} */ c) => ({ token: (await K.surfaces.open(c, {})).token });
  const as = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}, caller = "cli") => d.registry.call(tool, input, caller, await tokenOf(dev(p)));
  const ok = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(p, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  await ok(OWNER, "vault.put", { name: "work-mail-token", kind: "api-key", fields: { value: `fixture-token-${crypto.randomBytes(6).toString("hex")}` } });
  await ok(OWNER, "vault.grant", { name: "work-mail-token", module: "gate" });
  await K.gateway.grants.setRole(dev(OWNER), { person: BEN, role: "member" }, { presence: { op: "stand-in", fields: {}, n: 1 } }).catch(() => {});
  const uid = (await ok(OWNER, "agents.create", { name: "juno", kind: "agent" })).uid;
  const agentFor = async (/** @type {string} */ person) => ({ token: (await K.surfaces.open(dev(person), { agent: uid, session: `s-${person.slice(4, 8)}`, thread: `t-${person.slice(4, 8)}` })).token, thread: `t-${person.slice(4, 8)}`, agent: "juno" });
  const send = async (/** @type {string} */ person, /** @type {string} */ to) => d.registry.call("gate.request", { kind: "send", via: "mail", to, content: { subject: "Re: intake", body: "Hi, the form is on staging." } }, "module:mail", await agentFor(person));   // as the mail module files it in the agent's turn: the door keeps gate.request itself to the owner

  const made = await ok(OWNER, "gate.standing.add", { agent: "juno", kind: "send", via: "mail", to: { patterns: ["*@harlowlegal.com"] }, daily_cap: 5 });
  assert.ok(made.id);
  // for the owner, inside the permission: out at once
  const mine = (await send(OWNER, "dana@harlowlegal.com")).data;
  assert.equal(mine.state, "sent", JSON.stringify(mine));
  assert.equal(gmail.got.length, 1);
  // the same agent in Ben's turn, to the same recipient: not covered, held, and it is Ben's item
  const bens = (await send(BEN, "dana@harlowlegal.com")).data;
  assert.equal(bens.state, "held", "the owner's permission did not cover a member's agent: " + JSON.stringify(bens));
  assert.equal(gmail.got.length, 1, "nothing went out for Ben");
  assert.equal((await d.registry.call("gate.get", { id: bens.id }, "deck", await tokenOf(dev(BEN)))).data.requester, BEN);
  assert.equal((await d.registry.call("gate.get", { id: bens.id }, "deck", await tokenOf(dev(OWNER)))).error?.code, "not_found", "and the owner does not see it");
  // a member cannot give a standing permission over the owner's connection
  const mineAdd = await d.registry.call("gate.standing.add", { agent: "juno", kind: "send", via: "mail", to: { patterns: ["*@harlowlegal.com"] } }, "deck", await tokenOf(dev(BEN)));
  assert.ok(mineAdd.error, "a member cannot widen what the owner's connection may send by itself");
});
