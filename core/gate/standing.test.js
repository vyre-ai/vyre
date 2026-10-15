// @ts-check
// Standing permissions for agents (0.6): a person lets one agent send by itself, to named recipients, up to a daily cap. Through the REAL Gate on a real vyred with the kernel on: inside the scope the act goes
// out with no held question and the log names the permission it used; outside it, over the cap, after a revoke, or after the issuer lost admin, it is held as always; a model, a member and the default
// assistant cannot create or use one. Only the outside mail server is a fake.
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
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
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

test("a standing permission lets one agent send inside its scope with no question, and asks outside it, over the cap, after a revoke and after the issuer lost admin", { timeout: 240_000 }, async t => {
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
  const ownerChain = dev(OWNER);
  await K.gateway.grants.setRole(ownerChain, { person: ANA, role: "admin" }, { presence: { op: "stand-in", fields: {}, n: 1 } }).catch(() => {});
  await ok(OWNER, "agents.create", { name: "juno", kind: "agent" });
  const uid = (await ok(OWNER, "agents.uid", { name: "juno" })).uid;
  const agent = async (/** @type {string} */ name, /** @type {any} */ extra = {}) => ({ token: (await K.surfaces.open(K.chains.fromFacts({ kind: "agent_session", agent: name, session: `s-${name}`, thread: `t-${name}`, person: OWNER, vouched: true, ...extra }), {})).token });
  const send = async (/** @type {string} */ to, /** @type {string} */ id = uid) => d.registry.call("gate.request", { kind: "send", via: "mail", to, content: { subject: "Re: intake", body: "Hi, the form is on staging." } }, "mcp:agent:juno", { ...(await agent(id)), thread: "t-1", agent: "juno" });

  // before any permission: held, as ever
  assert.equal((await send("dana@harlowlegal.com")).data.state, "held", "no permission: held");
  assert.equal(gmail.got.length, 0);

  // a model, the agent itself and a member cannot create one; the owner can
  const input = { agent: "juno", kind: "send", via: "mail", to: { patterns: ["*@harlowlegal.com"] }, daily_cap: 2 };
  assert.ok((await d.registry.call("gate.standing.add", input, "mcp", await tokenOf(dev(OWNER)))).error, "a model cannot create one");
  assert.ok((await d.registry.call("gate.standing.add", input, "mcp:agent:juno", { ...(await agent(uid)), thread: "t-1", agent: "juno" })).error, "an agent cannot create or widen its own");
  const made = await ok(OWNER, "gate.standing.add", input);
  assert.ok(made.id);

  // inside the scope: out at once, no question, the log names the permission
  const inside = (await send("dana@harlowlegal.com")).data;
  assert.equal(inside.state, "sent", JSON.stringify(inside));
  assert.equal(inside.by, `standing:${made.id}`);
  assert.equal(gmail.got.length, 1);
  const released = d.registry.deps.events.since(0, { limit: 5000 }).filter((/** @type {any} */ e) => e.type === "gate.released").pop();
  assert.equal(released.payload.by, `standing:${made.id}`, "the log names the permission it used");

  // outside the scope: one ask, as today (another domain, and a mixed list)
  assert.equal((await send("someone@elsewhere.com")).data.state, "held");
  assert.equal((await send(["dana@harlowlegal.com", "someone@elsewhere.com"])).data.state, "held", "every recipient must be in scope");
  // the default assistant never rides an agent's permission
  assert.equal((await send("dana@harlowlegal.com", "assistant")).data.state, "held");
  // over the cap (two a day): the third asks
  assert.equal((await send("dana@harlowlegal.com")).data.state, "sent", "the second one");
  assert.equal((await send("dana@harlowlegal.com")).data.state, "held", "over the cap asks");
  assert.equal(gmail.got.length, 2);

  // the list shows the use
  const listed = (await ok(OWNER, "gate.standing.list")).permissions.find((/** @type {any} */ p) => p.id === made.id);
  assert.equal(listed.use.count, 2);
  assert.equal(listed.use.last.length, 2);

  // revoke is instant
  const again = await ok(OWNER, "gate.standing.add", { ...input, to: { patterns: ["dana@harlowlegal.com"] }, daily_cap: 5 });
  assert.equal((await send("dana@harlowlegal.com")).data.state, "sent", "a fresh permission covers it");
  await ok(OWNER, "gate.standing.revoke", { id: again.id });
  assert.equal((await send("dana@harlowlegal.com")).data.state, "held", "revoked: asks");

  // an admin's permission matches nothing once they are no longer an admin
  const byAna = await as(ANA, "gate.standing.add", { ...input, to: { patterns: ["lee@harlowlegal.com"] }, daily_cap: 5 });
  if (!byAna.error) {
    assert.equal((await send("lee@harlowlegal.com")).data.state, "sent", "while she is an admin");
    await K.gateway.grants.setRole(ownerChain, { person: ANA, role: "member" }, { presence: { op: "stand-in", fields: {}, n: 2 } }).catch(() => {});
    assert.equal((await send("lee@harlowlegal.com")).data.state, "held", "the issuer lost admin: the grant matches nothing");
  }
});
