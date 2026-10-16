// @ts-check
// A member's named agent (proven mcp:agent:<name> + thread) must never pass the member door into owner-scoped tool groups except the outward mail sends in MEMBER_NAMED_AGENT_GROUP; those reach the registry as the member and are held at the Gate, never run as the owner.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { GROUP_OF, SCOPED_GROUPS, MEMBER_NAMED_AGENT_GROUP, PLUMBING, SELF_GATED, OWNER_ONLY } from "./door-lists.js";
import { refusal } from "./door-gate.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

/** Tools in owner-scoped groups (handlers still use the Space's connections until SCOPED_GROUPS opens a group). @param {import("../modules/index.js").Registry} registry */
function ownerScopedTools(registry) {
  const scoped = new Set(SCOPED_GROUPS);
  return [...registry.tools.entries()]
    .filter(([, def]) => !def.internal && !def.hook)
    .map(([name]) => name)
    .filter(name => {
      const group = GROUP_OF.get(name);
      return Boolean(group && !scoped.has(group));
    })
    .sort();
}

/** @param {import("node:test").TestContext} t */
async function rig(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box" }));
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  const uid = (await d.registry.call("agents.create", { name: "juno", kind: "agent" }, "cli", { token: (await K.surfaces.open(chain(OWNER), {})).token })).data.uid;
  assert.ok(uid, "juno uid");
  const memberAgent = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const token = (await K.surfaces.open(chain(MEMBER), { agent: uid, session: "s-juno-m", thread: "t-juno-m" })).token;
    return d.registry.call(tool, input, "mcp:agent:juno", { token, thread: "t-juno-m", agent: "juno" });
  };
  return { d, memberAgent, OWNER, chain };
}

test("MEMBER_NAMED_AGENT_GROUP is only outward mail send tools that exist and stay in the mail group", { timeout: 60_000 }, async t => {
  const { d } = await rig(t);
  const have = new Set([...d.registry.tools.keys()]);
  for (const tool of MEMBER_NAMED_AGENT_GROUP) {
    assert.ok(have.has(tool), `${tool} is in the registry`);
    assert.equal(GROUP_OF.get(tool), "mail", `${tool} is a mail-group outward send`);
    const def = d.registry.tools.get(tool);
    assert.ok(def && (def.outward || def.asks), `${tool} is held at the Gate (outward or asks)`);
    if (tool === "mail.send") {
      assert.equal(def.outward, true, "mail.send is outward");
      assert.ok(!def.asks, "mail.send is held by the registry outward path, not module asks");
    }
  }
  const sends = ownerScopedTools(d.registry).filter(n => n === "mail.send" || n === "google.mail.send" || /^(mail|google\.mail)\./.test(n) && d.registry.tools.get(n)?.outward);
  for (const tool of sends) {
    if (tool.endsWith(".send") && (tool.startsWith("mail.") || tool.startsWith("google.mail."))) {
      assert.ok(MEMBER_NAMED_AGENT_GROUP.has(tool), `every mail send adapter in an owner-scoped group is listed: ${tool}`);
    }
  }
});

test("a member's named agent is door-refused on every owner-scoped group tool except the listed mail sends", { timeout: 600_000 }, async t => {
  const { d, memberAgent } = await rig(t);
  const allow = MEMBER_NAMED_AGENT_GROUP;
  /** @type {string[]} */ const leaked = [];
  for (const tool of ownerScopedTools(d.registry)) {
    if (allow.has(tool) || PLUMBING.has(tool) || SELF_GATED.has(tool)) continue;
    const r = await memberAgent(tool, {});
    const doorDenied = r.error && r.error.code === "denied" && r.error.message === refusal(tool);
    if (!doorDenied) leaked.push(`${tool}: ${JSON.stringify(r.error || r.data).slice(0, 120)}`);
  }
  assert.deepEqual(leaked, [], `these owner-scoped tools let a member's agent past the door (not in MEMBER_NAMED_AGENT_GROUP): ${leaked.join("; ")}`);
});

test("a member's named agent is not served the owner's memory, planner or vault", { timeout: 200_000 }, async t => {
  const { memberAgent } = await rig(t);
  const ownerOnly = ["settings.set", "computers.list", "spend.raise", "artifacts.list", "github.accounts", "publish.create", "connectors.connect"];
  for (const tool of ownerOnly) {
    assert.ok(OWNER_ONLY.has(tool), `${tool} is owner-only on the door lists`);
    const r = await memberAgent(tool, {});
    assert.ok(r.error && r.error.code === "denied", `${tool}: a member's agent must not act as the owner, got ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(r.error.message, refusal(tool), `${tool}: refused at the member door in the owner's words`);
  }
});

test("a member's named agent on mail.send is held at the Gate as the member, not door-refused and not sent as the owner", { timeout: 200_000 }, async t => {
  const { d, memberAgent } = await rig(t);
  const mail = d.registry.tools.get("mail.send");
  let runs = 0;
  const run = mail.run;
  mail.run = async (...a) => { runs++; return run(...a); };
  /** @type {any[]} */ const sent = [];
  d.registry.deps.events?.on?.("mail.sent", e => sent.push(e));
  const r = await memberAgent("mail.send", { to: "dana@example.com", subject: "Hi", body: "test" });
  assert.ok(!(r.error && r.error.message === refusal("mail.send")), "the outward send passes the member door");
  assert.equal(runs, 0, "the registry outward hold runs before the mail module");
  assert.equal(r.error?.code, "held_for_approval", `one-tap approval, nothing ran: ${JSON.stringify(r.error || r.data).slice(0, 200)}`);
  assert.equal(sent.length, 0, "mail is never sent unheld");
});
