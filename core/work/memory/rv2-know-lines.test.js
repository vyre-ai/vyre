// reviewer-2 repro KW-1 against origin/work/kernel-work-handle 3ba1b7df3 (drop into core/work/memory/): the lines the session capture hands to work.know.capture have no `record`, so they are gated by
// the session's own resource, and every Space member's role grant covers it. A member reads another person's private session through Space memory.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { tempHome } from "../../../test/helpers.js";
import { createRig } from "../../../test/kernel-rig.js";
import { createMemoryEngine } from "./index.js";

const MEMORY = { name: "memory", needs: { kernel: { actions: ["records.read", "records.create", "events.read", "tasks.request"] } } };

test("KW-1: a plain member recalls and finds the lines of the owner's private session", async t => {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["juno"], defs: [] });          // bob keeps his ordinary member role: no restrict()
  const mem = rig.k.kernelFor(MEMORY);
  const db = open(path.join(tempHome(t), "engine.db"));
  const engine = createMemoryEngine({ kernel: rig.kernel, db, space: rig.space, serviceChain: mem.serviceChain(), chainFor: p => rig.withService(rig.person(p.id), "memory"), personChain: p => rig.person(p.id), clock: () => 1000, ownerOf: () => rig.actor("person", "per_alex") });
  // exactly what the capture does: { session, lines } and no record
  engine.lines.ingest("alex-private-chat", [{ seq: 1, role: "user", text: "Tell the court that my client will settle for 40000 and keep it from the partners", at: 1 }]);
  await engine.index({ kind: "lines", session: "alex-private-chat" });
  const bob = rig.person("per_bob");
  const recalled = await engine.lines.recall(bob, "alex-private-chat", 1, 1);
  const found = await engine.search(bob, "settle for 40000", 6);
  console.log("KW-1 bob recalled:", JSON.stringify(recalled.map(l => l.text)), "| bob search hits:", found.length);
  assert.equal(recalled.length, 0, "a member who is not in alex's session must not read its lines");
  assert.equal(found.length, 0, "nor find them by meaning");
});
