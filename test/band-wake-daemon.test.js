// @ts-check
// A task's own words reach an agent as instructions only when the kernel says the person who made the task holds use of that agent now (core/daemon/agent-wake.js, flows-host mayUse), on a REAL vyred with the
// kernel on. The owner uses every agent; a member the agent is not shared with does not. Run it on a test box, never on a person's Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("the owner's words to an agent are instructions, a member's who does not use that agent are information", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space, ask = K.gateway.ask;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const anaChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-ana", person: ANA, path: "relay" });
  await K.gateway.grants.setRole(ownerChain, { person: ANA, role: "member" }, { presence: proof() });
  const token = (await K.surfaces.open(ownerChain, {})).token;
  const made = await d.registry.call("agents.create", { name: "bandy", kind: "agent", projects: "*" }, "cli", { token });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  await K.gateway.grants.addActor(ownerChain, { kind: "agent", id: "bandy", space }, {});
  const woke = /** @type {any[]} */ ([]);
  const real = d.registry.call.bind(d.registry);
  d.registry.call = async (tool, input, caller, meta) => { if (tool === "agents.wake") { woke.push(input); return { data: { thread: "th-" + input.task, already: false } }; } return real(tool, input, caller, meta); };
  const doer = { kind: "agent", id: "bandy", space };
  const mine = await ask.request(ownerChain, { title: "Owner asks", doer, output: { kind: "note" }, source: "assistant_request", form: { instructions: "OWNER-WORDS" } });
  let theirs = null;
  try { theirs = await ask.request(anaChain, { title: "Member asks", doer, output: { kind: "note" }, source: "assistant_request", form: { instructions: "MEMBER-WORDS" } }); } catch { /* a member may not give an agent a task at all: then nothing woke */ }
  for (let i = 0; i < 100 && woke.length < (theirs ? 2 : 1); i++) await new Promise(r => setTimeout(r, 100));
  const w = (/** @type {string} */ id) => woke.find(x => x.task === id);
  assert.ok(w(mine.id), "the owner's task woke the agent");
  assert.equal(w(mine.id).instructions, "OWNER-WORDS");
  if (theirs) {
    assert.ok(w(theirs.id), "the member's task woke the agent");
    assert.equal(w(theirs.id).instructions, undefined, "a member who does not use the agent does not instruct it");
    assert.equal(w(theirs.id).info.from_requester, "MEMBER-WORDS");
  }
});
