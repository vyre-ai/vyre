// @ts-check
// The owner and the admins cannot see or open a login a member shared with an agent, through any tool of the real registry (V3a). A real daemon with the kernel on: an owner, an admin, a member with a vault of their
// own, an agent. The member puts a login in their vault and shares it with the agent. Then every tool that could list, read or open a vault item is asked for it, by the reference the agent is told and by the
// member's own name for it, as the owner and as the admin; none answers a value, and the password is nowhere in anything any of them returned. The agent, for its part, is told the reference and no value.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import fs from "node:fs";
import path from "node:path";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ADA = "per_" + "defghijklmnopqrstuvwxyzabc";
const PW = "a long master password for the test", PASS = "fixture-member-password-0123456789ab", LABEL = "my-secret-bank-login", ORIGIN = "https://bank.example.com";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a login a member shared with an agent cannot be seen or opened by the owner or an admin, through any vault tool", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.grants.setRole(chain(OWNER), { person: BEN, role: "member" }, { presence: proof() });
  await K.gateway.grants.setRole(chain(OWNER), { person: ADA, role: "admin" }, { presence: proof() });
  const tok = async (/** @type {string} */ p) => (await K.surfaces.open(chain(p), {})).token;
  const tokens = { owner: await tok(OWNER), ada: await tok(ADA), ben: await tok(BEN) };
  const seen = /** @type {any[]} */ ([]);
  const as = async (/** @type {"owner"|"ada"|"ben"} */ w, /** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const r = await d.registry.call(tool, input, w === "owner" ? "cli" : "device:abcdefghijklmnop", { token: tokens[w], ...(w === "owner" ? {} : { person: { id: "ps-" + w, kind: "passkey" } }) });
    seen.push(r); return r;
  };
  const ok = async (/** @type {any} */ w, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(w, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };

  assert.ok((await ok("ben", "vault.me.account.create", { password: PW })));
  await ok("ben", "vault.me.put", { name: LABEL, kind: "login", fields: { username: "ben@personal.example", password: PASS } });
  const uid = (await ok("ben", "agents.create", { name: "juno", kind: "agent" })).uid;   // Ben makes his own agent: only an agent he may instruct can be lent a login
  const shared = await ok("ben", "vault.me.share.agent", { item: LABEL, agent: "juno", origin: ORIGIN });
  const ref = shared.shared.ref;
  assert.equal(shared.notice, "Your agent can use this login while you're away.");

  // the agent is told the reference and the label, no value
  const agentList = await d.registry.call("vault.list", {}, "mcp:agent:juno", { token: (await K.surfaces.open(chain(OWNER), { agent: uid, session: "s-juno", thread: "t-juno" })).token, thread: "t-juno", agent: "juno" });
  seen.push(agentList);
  assert.ok((agentList.data.items || []).some((/** @type {any} */ i) => i.name === ref && i.label === LABEL), "the agent is told the reference: " + JSON.stringify(agentList).slice(0, 200));

  // the owner and the admin: every tool that could list, read or open a vault item, asked by the reference and by the member's name for it
  for (const who of /** @type {const} */ (["owner", "ada"])) {
    const list = await as(who, "vault.list", {});
    const names = JSON.stringify(list.data || list.error);
    assert.ok(!names.includes(ref) && !names.includes(LABEL), `${who}'s vault list does not show it`);
    for (const tool of ["vault.get", "vault.item", "vault.reveal", "vault.copy", "vault.resolve", "vault.render", "vault.inject", "vault.totp", "vault.codes", "vault.fill.native", "vault.delete", "vault.update"]) {
      for (const name of [ref, LABEL]) {
        const r = await as(who, tool, { name, item: name, credential: name });
        assert.ok(r.error || (r.data && !JSON.stringify(r.data).includes(PASS)), `${who} ${tool} ${name === ref ? "by reference" : "by the member's name"} gave no value: ${JSON.stringify(r).slice(0, 160)}`);
      }
    }
    assert.ok(!(await as(who, "vault.me.shares", {})).data?.shares?.length, `${who} has no shares of their own to list (and Ben's are not theirs)`);
  }
  // the owner and the admin also cannot end Ben's share through his tools
  for (const who of /** @type {const} */ (["owner", "ada"])) assert.ok((await as(who, "vault.me.unshare.agent", { item: LABEL })).error, `${who} cannot use the member's share tools`);
  assert.ok(!JSON.stringify(seen).includes(PASS), "the password is in nothing any caller received");
  assert.deepEqual((await ok("ben", "vault.me.shares")).shares.map((/** @type {any} */ s) => s.ref), [ref], "and Ben's share is still there");
});
