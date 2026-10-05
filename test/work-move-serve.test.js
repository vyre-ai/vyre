// @ts-check
// The source side of a move to another server: the spaces module serves the target's pull from the work module, under the person's own chain, and only for a move the Space's own log started.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { planRemoteMove } from "../core/work/project-move-remote.js";
import { tempHome, present, kernelCaller } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);
const MOVE = "11111111-1111-4111-8111-111111111111";

test("work.move.serve answers plan, record and file for a move this Space started, under the person's chain, and refuses everything else", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const call = kernelCaller(d, root);
  const owner = d.kernel.id.owner, space = d.kernel.id.space, G = d.kernel.gateway;
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const made = await call("work.project.create", { name: "Rivera" });
  const urn = made.data.project, folder = made.data.drive_path;
  await G.drive.put(admin, `${folder}/retainer.txt`, enc("signed retainer"));
  const chatRec = await G.records.create(admin, "chat-record", { title: "Intake", chat: "chat_x", project: { urn }, drive: folder });
  // the plan the person approved, as the spaces module recomputes it at the source
  const side = { space, records: G.records, drive: G.drive, chain: admin, types: async () => [] };
  const approved = await planRemoteMove({ from: side, to: { space: "spc_otherserver00" }, project: urn });
  assert.deepEqual(approved.blockers, []);
  const serve = (/** @type {any} */ input, caller = "module:spaces") => d.registry.call("work.move.serve", { space, person: owner, move_id: MOVE, plan_hash: approved.hash, project: urn, to_space: "spc_otherserver00", ...input }, caller);
  // no move started yet
  assert.equal((await serve({ op: "plan" })).error?.code, "not_found");
  G.log ? null : null;
  d.kernel.log.append(admin, { type: "project.move_started", sv: 1, subject: urn, data: { move_id: MOVE, to: "spc_otherserver00", plan_hash: approved.hash } });
  const plan = await serve({ op: "plan" });
  assert.ok(plan.data, JSON.stringify(plan));
  assert.equal(plan.data.hash, approved.hash, "recomputed here, and the approved one");
  assert.ok(plan.data.files.some((/** @type {any} */ f) => f.path === `${folder}/retainer.txt` && f.size === 15), JSON.stringify(plan.data.files));
  assert.ok(plan.data.ids.includes(chatRec.urn));
  const rec = await serve({ op: "record", urn: chatRec.urn });
  assert.equal(rec.data.data.title, "Intake");
  assert.equal((await serve({ op: "record", urn: `vyre://${space}/project/someone-elses` })).error?.code, "denied", "only this project's records");
  const f = await serve({ op: "file", path: `${folder}/retainer.txt`, offset: 7, length: 8 });
  assert.equal(Buffer.from(f.data.base64, "base64").toString(), "retainer", "a range of the file");
  assert.equal((await serve({ op: "file", path: "Projects/elsewhere/x.txt" })).error?.code, "denied", "only this project's folder");
  assert.equal((await serve({ op: "file", path: `${folder}/../elsewhere/x.txt` })).error?.code, "denied");
  assert.equal((await serve({ op: "sealed", ref: "r" })).error?.code, "unavailable", "sealed values wait for the sealing process");
  // not the spaces module, a different plan hash, another person
  assert.equal((await serve({ op: "plan" }, "module:sessions")).error?.code, "denied");
  assert.equal((await serve({ op: "plan", plan_hash: "x".repeat(43) })).error?.code, "not_found");
  assert.equal((await d.registry.call("work.move.serve", { space, person: "per_stranger", op: "plan", move_id: MOVE, plan_hash: approved.hash, project: urn }, "module:spaces")).error ? true : false, true);
});
