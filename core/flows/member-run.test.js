// @ts-check
// A member's own Flow on the team's server, after class 3 (the link read leaves out rows of a type a module keeps): she defines a manual Flow, approves her own version, starts it, and it runs; she finds her run and the
// record it made; another member reads no flow-run row on the raw routes; the owner reads the run whole. Real daemon, a hosted team Space. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { createMemberTools } from "../work/member-tools.js";
import * as CORE from "../../records/core-types.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ZED = "per_" + "defghijklmnopqrstuvwxyzabc", ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await new Promise(r => setTimeout(r, 200)); } };

test("a member defines, approves and starts her own Flow; the run is found by its starter and the owner, and no other member reads its flow-run row", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const K = firm.kernel, gw = firm.gateway;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ZED, ANA]) await gw.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  const have = new Set(((await gw.definitions(ownerChain)).types || []).map((/** @type {any} */ x) => x.name));
  const add = [CORE.ORGANIZATION].filter(x => x && !have.has(x.name));
  if (add.length) await gw.records.define(ownerChain, { add_types: add });
  const chainOf = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "relay" });
  const door = createMemberTools({ space: firm.space, kernel: K, registry: d.registry });

  const flow = { format: 1, name: "zed_makes_an_org", label: "Zed's Flow", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "mk", kind: "create", type: "organization", set: { name: "MADE-BY-ZEDS-FLOW" } }] };
  const defined = await door.flows.define(chainOf(ZED), { flow });
  assert.ok(defined && (defined.ok !== false) && defined.id, "she sets up her Flow: " + JSON.stringify(defined).slice(0, 200));
  const approved = await door.flows.approve(chainOf(ZED), { id: defined.id, version: defined.version, hash: defined.hash });
  assert.ok(approved && approved.ok !== false, "she approves her own version: " + JSON.stringify(approved).slice(0, 300));
  const started = await door.flows.start(chainOf(ZED), { id: defined.id });
  assert.ok(started, "she starts it");
  const runId = started.run || started.id || (started.run && started.run.id);
  assert.ok(runId, "the start answers the run: " + JSON.stringify(started).slice(0, 200));
  await until(async () => { const r = await door.flows.run(chainOf(ZED), { run: runId }); return r && r.run && (r.run.state === "done" || r.run.state === "failed") ? r : null; }, "the run to end");
  const mine = await door.flows.runs(chainOf(ZED), { flow: defined.id });
  const row = (Array.isArray(mine) ? mine : mine.runs || []).find((/** @type {any} */ r) => r.id === runId);
  assert.ok(row && row.started_by_me === true, "she finds her own run, marked as hers");
  assert.equal((((await door.flows.run(chainOf(ZED), { run: runId })) || {}).run || {}).state, "done", "and it ran to the end");
  assert.ok((await gw.records.query(ownerChain, "organization", { page: { limit: 50 } })).rows.some((/** @type {any} */ r) => r.data.name === "MADE-BY-ZEDS-FLOW"), "the record it made is there");
  // the raw routes: the run's rows are the Flows' own (kept); the owner reads them, a member does not, and a link read gives a member none of them
  const runRows = async (/** @type {any} */ chain) => (await gw.records.query(chain, "flow-run", { page: { limit: 50 } })).rows.length;
  assert.ok(await runRows(ownerChain) >= 1, "the owner reads the run's row");
  assert.equal(await runRows(chainOf(ZED)), 0, "the starter has no raw route to the run's row");
  assert.equal(await runRows(chainOf(ANA)), 0, "nor does another member");
  const org = (await gw.records.query(ownerChain, "organization", { page: { limit: 50 } })).rows.find((/** @type {any} */ r) => r.data.name === "MADE-BY-ZEDS-FLOW");
  assert.equal(((await gw.records.linked(chainOf(ANA), org.urn)).rows || []).filter((/** @type {any} */ r) => r.type === "flow-run").length, 0, "a link read gives another member no run");
});
