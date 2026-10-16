// @ts-check
// mail.send uses the registry outward hold (module.json: outward, not asks): every agent and MCP caller is held for one-tap approval before the mail module runs; nothing is sent unheld. google.mail.send keeps its own ask flow (asks: true) and is covered for member agents in door-gate-member-agent.test.js.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { MEMBER_NAMED_AGENT_GROUP } from "../modules/door-lists.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

const SEND = { to: "dana@example.com", subject: "Hi", body: "test" };
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** @param {import("node:test").TestContext} t */
async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box" }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  return d;
}

test("MEMBER_NAMED_AGENT_GROUP lists both mail facade and google adapter sends", () => {
  assert.ok(MEMBER_NAMED_AGENT_GROUP.has("mail.send"));
  assert.ok(MEMBER_NAMED_AGENT_GROUP.has("google.mail.send"));
});

test("registry outward hold: mail.send never runs for MCP callers until approval; nothing is sent", { timeout: 120_000 }, async t => {
  const d = await boot(t);
  const mail = d.registry.tools.get("mail.send");
  assert.ok(mail && mail.outward === true && !mail.asks, "mail.send is held by the registry, not module asks");
  let runs = 0;
  const run = mail.run;
  mail.run = async (...a) => { runs++; return run(...a); };
  /** @type {any[]} */ const sent = [];
  d.registry.deps.events?.on?.("mail.sent", e => sent.push(e));

  const cases = [
    ["mcp:agent:kit", { thread: "t-kit" }],
    ["mcp", { thread: "t-mcp" }],
    ["harness", { thread: "t-harness" }],
  ];
  for (const [caller, meta] of cases) {
    runs = 0;
    const r = await d.registry.call("mail.send", SEND, caller, meta);
    assert.equal(runs, 0, `${caller}: the mail module must not run on the first call`);
    assert.equal(r.error?.code, "held_for_approval", `${caller}: ${JSON.stringify(r.error || r.data).slice(0, 200)}`);
    assert.equal(sent.length, 0, `${caller}: mail.sent must not fire before approval`);
  }
});

test("registry outward hold: owner's and member's named agents on mail.send", { timeout: 240_000 }, async t => {
  const d = await boot(t);
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const mail = d.registry.tools.get("mail.send");
  let runs = 0;
  const run = mail.run;
  mail.run = async (...a) => { runs++; return run(...a); };
  /** @type {any[]} */ const sent = [];
  d.registry.deps.events?.on?.("mail.sent", e => sent.push(e));

  const kitUid = (await d.registry.call("agents.create", { name: "kit", kind: "agent" }, "cli", { token: (await K.surfaces.open(chain(OWNER), {})).token })).data.uid;
  assert.ok(kitUid);
  const ownerAgent = async () => {
    const token = (await K.surfaces.open(chain(OWNER), { agent: kitUid, session: "s-kit", thread: "t-kit-o" })).token;
    return d.registry.call("mail.send", SEND, "mcp:agent:kit", { token, thread: "t-kit-o", agent: "kit" });
  };
  runs = 0;
  const o = await ownerAgent();
  assert.equal(runs, 0, "owner's named agent: module did not run");
  assert.equal(o.error?.code, "held_for_approval", JSON.stringify(o.error || o.data).slice(0, 200));
  assert.equal(sent.length, 0);

  await K.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  const junoUid = (await d.registry.call("agents.create", { name: "juno", kind: "agent" }, "cli", { token: (await K.surfaces.open(chain(OWNER), {})).token })).data.uid;
  assert.ok(junoUid);
  const memberAgent = async () => {
    const token = (await K.surfaces.open(chain(MEMBER), { agent: junoUid, session: "s-juno", thread: "t-juno-m" })).token;
    return d.registry.call("mail.send", SEND, "mcp:agent:juno", { token, thread: "t-juno-m", agent: "juno" });
  };
  runs = 0;
  const m = await memberAgent();
  assert.equal(runs, 0, "member's named agent: module did not run");
  assert.equal(m.error?.code, "held_for_approval", JSON.stringify(m.error || m.data).slice(0, 200));
  assert.equal(sent.length, 0);
});

test("google.mail.send ask flow: a member's named agent is held and never sends without approval", { timeout: 120_000 }, async t => {
  const d = await boot(t);
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  const uid = (await d.registry.call("agents.create", { name: "juno", kind: "agent" }, "cli", { token: (await K.surfaces.open(chain(OWNER), {})).token })).data.uid;
  const token = (await K.surfaces.open(chain(MEMBER), { agent: uid, session: "s-j", thread: "t-j" })).token;
  const g = d.registry.tools.get("google.mail.send");
  assert.ok(g && g.asks && g.outward, "adapter send uses module ask hold, not registry");
  let runs = 0;
  const run = g.run;
  g.run = async (...a) => { runs++; return run(...a); };
  const r = await d.registry.call("google.mail.send", { account: "cn_test", to: ["x@example.com"], subject: "s", body: "b" }, "mcp:agent:juno", { token, thread: "t-j", agent: "juno" });
  const snap = JSON.stringify(r.error || r.data || {}).slice(0, 240);
  assert.ok(r.error || r.data?.held, `held or refused before anything leaves: ${snap}`);
  assert.ok(!r.data?.sent, `mail is never sent unheld: ${snap}`);
  if (!r.error) assert.ok(r.data?.held, `module ask hold, not a bare success: ${snap}`);
});
