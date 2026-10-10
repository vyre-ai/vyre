// @ts-check
// Two small things on a REAL vyred (design, rc.2). "Turn this into a Flow": flows.from-chat makes a draft, and the chat finds it as the Flow that was not there before the tap (draft-watch.js), never approved.
// "While you were away": the space's events (records.events, the read the Now card makes) count a finished run since a cursor, and nothing since the newest position. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { newDraft, flowsFrom } from "../apps/app/src/chat/draft-watch.js";
import { changesSince, awayLines, isMajor, topSeq } from "../apps/app/src/state/away.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const DOSSIER = { name: "dossier", label: "Dossier", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Engagement"] }], stages: [{ name: "Intake" }, { name: "Engagement" }] };
const NOTE = { name: "welcome-note", label: "Welcome note", fields: [{ name: "body", kind: "text", label: "Body" }] };

test("a Flow made from a chat is found as the new one and is a draft; a finished run is counted once since the cursor, then nothing", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const host = d.registry.deps.flowsHost.get(d.kernel.id.space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await meta());
  await d.kernel.gateway.records.define(admin, { add_types: [DOSSIER, NOTE] });

  // "Turn this into a Flow"
  const listed = async () => flowsFrom((await call("records.list", { type: "def-flow" })).data);
  const before = (await listed()).map((r) => r.id);
  const made = await call("flows.from-chat", { name: "Open a dossier", calls: [{ tool: "work_call", input: { tool: "dossiers.create", input: { data: { name: "Rivera" } } } }] });
  assert.ok(!made.error && made.data.ok, JSON.stringify(made));
  const hit = newDraft(before, await listed());
  assert.ok(hit, "the chat finds the draft the assistant made");
  assert.equal(hit.id, made.data.id);
  assert.equal(hit.title, "Open a dossier", "and says it by its own label");
  assert.equal(newDraft([...before, hit.id], await listed()), null, "once known it is not new again");
  assert.equal((await call("flows.get", { id: hit.id })).data.approver ?? null, null, "a draft, never approved");

  // "While you were away": a run finishes
  const def = await call("flows.define", { flow: { format: 1, name: "welcome", label: "Welcome the client", authorship: "human", trigger: { on: "stage", type: "dossier", stage: "Engagement" }, steps: [{ id: "note", kind: "create", label: "Welcome note", type: "welcome-note", set: { body: "Welcome" } }] } });
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });
  const first = (await call("records.events", { limit: 500 })).data.events;
  const cursor = topSeq(first);
  const rec = await d.kernel.gateway.records.create(admin, "dossier", { name: "Rivera Family Trust", stage: "Intake" });
  await d.kernel.gateway.records.update(admin, "dossier", rec.id, { stage: "Engagement" }, rec.version);
  await until(async () => { const r = (await call("flows.runs", { id: def.data.id })).data || []; return r.length && r.every((/** @type {any} */ x) => x.state === "done"); }, "the run to finish");
  const since = (await call("records.events", { since: cursor, limit: 500 })).data.events;
  const c = changesSince(since, [], [], cursor);
  assert.equal(c.finished, 1, "one run finished while away");
  assert.equal(isMajor(c), true);
  assert.deepEqual(awayLines(c), ["1 Flow run finished"]);
  const seen = topSeq(since);
  assert.equal(isMajor(changesSince((await call("records.events", { since: seen, limit: 500 })).data.events, [], [], seen)), false, "once seen it does not come back");
});
