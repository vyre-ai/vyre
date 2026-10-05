// @ts-check
// SCRATCH (work/move-int): the same-home cross-Space project move end to end through the real tools, on real gateways, with windows' moves, network-2's per-Space Drive and memory's room move.
// carryFiles is network-2's real one (kernel/moves/carry.js). Memory is skipped (VYRE_TEST_SKIP_MEMORY) until it adapts; the Work-engine row is not seeded (hosted Spaces share one module store).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present, kernelCaller } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_TEST_SKIP_MEMORY = "1";
const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);

test("a project moves to another hosted Space: records, files, a chat folder, memory and Work-engine lines, one approval", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const call = kernelCaller(d, root);
  const owner = d.kernel.id.owner;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const firm = await d.kernel.spaces.host({ owner, name: "Harlow Legal" });
  assert.ok(firm.gateway.drive, "network-2: the hosted Space has its own Drive");
  const made = await call("work.project.create", { name: "Rivera" });
  assert.ok(made.data, JSON.stringify(made));
  const urn = made.data.project, id = urn.split("/").pop(), root_ = made.data.drive_path;
  const G = d.kernel.gateway;
  await G.records.create(admin, "session-summary", { title: "Intake", thread: "t-1", project: { urn }, drive: root_ });
  await G.drive.put(admin, `${root_}/retainer.txt`, enc("signed"));
  const chat = await G.grants.chats.create(admin, {});
  await G.drive.put(admin, `${root_}/chat/${chat.id}/note.txt`, enc("from the chat"));
  const plan = await call("work.project.move-plan", { project: urn, to_space: firm.space });
  console.log("plan:", JSON.stringify(plan).slice(0, 600));
  assert.ok(plan.data, JSON.stringify(plan));
  assert.deepEqual(plan.data.blockers, [], JSON.stringify(plan.data.blockers));
  const moved = await call("work.project.move", { project: urn, to_space: firm.space, plan_hash: plan.data.plan_hash });
  console.log("move:", JSON.stringify(moved).slice(0, 800));
  assert.ok(moved.data, JSON.stringify(moved));
  const tgt = moved.data.project;
  const firmAdmin = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-h", person: owner, path: "direct", session: "s" });
  const rec = await firm.gateway.records.get(firmAdmin, "project", tgt.split("/").pop());
  assert.equal(rec.data.name, "Rivera");
  assert.equal(rec.data.moved_from, `${d.kernel.id.space}:${urn}`);
  const got = await firm.gateway.drive.get(firmAdmin, `${rec.data.drive_path}/retainer.txt`);
  assert.equal(Buffer.from(got.bytes || got.data || got).toString(), "signed");
  const src = await G.records.get(admin, "project", id);
  assert.equal(src.data.status, "moved");
  assert.equal((await G.drive.list(admin, root_)).length, 0, "nothing left behind in the old Space's Drive");
});
