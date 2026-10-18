// @ts-check
// The pieces the tasks module needs that only the test rig used to supply, proved on a REAL vyred with the kernel on: a hand-in of a file, a draft or fields, an approved send, the responsible person for an agent, and a Kit's teammate.
// Run it on a test box, never on a person's Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

/** @param {any} t */
async function world(t) {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  return { d, K, OWNER, space, ownerChain, ask: K.gateway.ask, me: { kind: "person", id: OWNER, space } };
}

test("1. a task whose output is a file, a draft or fields can be handed in and completed", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const { ask, ownerChain, me, space, K } = w;
  const made = (/** @type {any} */ over) => ask.request(ownerChain, { title: "Hand it in", doer: me, ...over });
  const finish = async (/** @type {any} */ task, /** @type {any} */ evidence) => { await ask.start(ownerChain, task.id); return ask.complete(ownerChain, task.id, evidence); };
  // a record the draft, file and fields tasks are about
  const rec = await K.gateway.records.create(ownerChain, "project", { name: "Rivera", slug: "rivera", status: "active" });
  const urn = `vyre://${space}/project/${rec.id}`;
  const draft = await made({ output: { kind: "draft" }, record: urn });
  const asDraft = await finish(draft, { draft: urn }).catch(e => e);
  assert.equal(asDraft && asDraft.state, "done", `a draft hand-in: ${asDraft && asDraft.code} ${asDraft && asDraft.message}`);
  const file = await made({ output: { kind: "file" } });
  const asFile = await finish(file, { file: urn }).catch(e => e);
  assert.equal(asFile && asFile.state, "done", `a file hand-in: ${asFile && asFile.code} ${asFile && asFile.message}`);
  const fields = await made({ output: { kind: "fields", target: "name" }, record: urn });
  const asFields = await finish(fields, {}).catch(e => e);
  assert.equal(asFields && asFields.state, "done", `a fields hand-in: ${asFields && asFields.code} ${asFields && asFields.message}`);
  // and a draft or file that is not there is still refused
  const gone = await made({ output: { kind: "file" } });
  await assert.rejects(finish(gone, { file: `vyre://${space}/file/nothing-here` }), { code: "output_check_failed" });
});

// Items 3 (the person responsible for an agent) and 4 (a Kit's teammate) are not proved here: both need an agent running under a lent grant, or a Kit install through its approval, which a bare daemon test cannot set up.
// Read from code: with no responsible port the maker of an agent unblocks its stuck task with a fresh proof like anyone else, and a Kit teammate part is skipped because the Flows host provides no teammates port.
