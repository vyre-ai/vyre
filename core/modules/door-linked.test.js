// @ts-check
// Linked folders on a REAL daemon with the door gate on (a team: the owner and one member): a member's session reaches the linked-folder tools (they are on her list, and each keeps her to her own),
// the chat's own mentions.resolve stays closed to her, and a guest is refused. The handlers' own member rules are in core/files/linked.test.js.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { MEMBER_MAY, OWNER_ONLY } from "./door-lists.js";
import { refusal } from "./door-gate.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const LINKED = ["files.linked.delete", "files.linked.link", "files.linked.list", "files.linked.ls", "files.linked.mentions.search", "files.linked.pick", "files.linked.providers", "files.linked.read", "files.linked.rename", "files.linked.search", "files.linked.status", "files.linked.sync", "files.linked.tree", "files.linked.unlink", "files.linked.versions", "files.linked.write"];

test("a member's session reaches every linked-folder tool, mentions.resolve stays the chat's, and a guest is refused", { timeout: 200_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner;
  const chain = (/** @type {string} */ p) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s" });
  await d.kernel.gateway.grants.setRole(chain(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  const token = (await d.kernel.surfaces.open(chain(MEMBER), { agent: "assistant" })).token;
  const as = (/** @type {string} */ tool, input = {}, caller = "cli") => d.registry.call(tool, input, caller, { thread: "t1", agent: "assistant", agentKind: "assistant", token });
  for (const n of LINKED) assert.ok(MEMBER_MAY.has(n) && !OWNER_ONLY.has(n), `${n} is on a member's list`);
  assert.ok(OWNER_ONLY.has("files.linked.mentions.resolve") && !MEMBER_MAY.has("files.linked.mentions.resolve"));
  for (const n of ["files.linked.providers", "files.linked.list", "files.linked.tree", "files.linked.search"]) {
    const r = await as(n, n.endsWith("search") ? { q: "x" } : {});
    assert.notEqual(r && r.error && r.error.message, refusal(n), `${n} is not refused at the door`);
  }
  const mine = await as("files.linked.list");
  assert.ok(!mine.error, `her list is served: ${JSON.stringify(mine).slice(0, 200)}`);
  const res = await as("files.linked.mentions.resolve", { id: "x:y", thread: "t1" });
  assert.equal(res.error && res.error.message, refusal("files.linked.mentions.resolve"));
  const guest = await d.registry.call("files.linked.list", {}, "tailnet-guest:n1", {});
  assert.equal(guest.error && guest.error.message, refusal("files.linked.list"), "a guest is refused");
});
