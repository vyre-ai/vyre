import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Switchboard } from "./index.js";

test("a kernel session that opens after its bound must not replace the session of the turn that is running now", async () => {
  let releaseB = () => {};
  const slowB = new Promise(r => { releaseB = r; });
  const ended = [];
  const sess = (who) => ({ asker: who, token: () => `tok-${who}`, end: async () => { ended.push(who); } });
  const C = sess("per_carol");
  const sb = /** @type {any} */ ({
    ksCur: new Map([["t", { ...C, turn: true, asker: "per_carol" }]]), live: new Map([["t", { turn: { id: 1 } }]]), turnAsker: new Map([["t", "per_carol"]]), turnSpace: new Map(),
    db: { prepare: () => ({ run: () => ({}) }) },
    deps: { log() {}, kernelSession: async (/** @type {any} */ o) => { if (o.asker === "per_bob") { await slowB; return sess("per_bob"); } return sess(o.asker); } },
  });
  sb.renewKernelSession = Switchboard.prototype.renewKernelSession;
  sb.endKernelSession = Switchboard.prototype.endKernelSession;
  const r = await Switchboard.prototype.renewCapped.call(sb, "t", {}, { chat: "c", asker: "per_bob" }, 20);
  assert.equal(r, "capped", "Bob's open is too slow: his row is dropped");
  releaseB();                                       // ... and then it completes, while Carol's turn is running on her own session
  await new Promise(r => setTimeout(r, 50));
  const cur = sb.ksCur.get("t");
  assert.equal(cur && cur.asker, "per_carol", "Carol's running turn still runs on Carol's session, not Bob's: current is " + (cur && cur.asker) + "; ended: " + ended.join(","));
});
