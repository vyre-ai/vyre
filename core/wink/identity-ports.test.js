import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { identityPorts } from "./identity-ports.js";
import { pairToMessage } from "./pairing.js";

test("Wink's identity ports read the spaces module live and answer null when it is absent or refuses", async () => {
  const calls = [];
  const spaces = {
    "spaces.identity.state": i => ({ data: { entries: i.person === "per_alex" ? [{ eid: "e1", kind: "device", pub: "PUB" }, { eid: "r1", kind: "recovery", pub: "R" }] : [] } }),
    "spaces.identity.sign": i => ({ data: { eid: "e1", sig: "S:" + i.message } }),
    "spaces.identity.entry": i => (i.eid === "e1" ? { data: { eid: "e1", kind: "device", pub: "PUB" } } : { data: null }),
    "spaces.identity.self": () => ({ data: { label: "alex", id: "per_alex" } }),
  };
  const p = identityPorts({ call: async (t, i) => { calls.push(t); if (!spaces[t]) throw new Error("no such tool"); return spaces[t](i); }, space: async () => "harlow" });
  assert.deepEqual(await p.identityEntry("per_alex", "e1"), { eid: "e1", kind: "device", pub: "PUB", identity: "per_alex" });
  assert.equal(await p.identityEntry("per_alex", "r1"), null, "a recovery entry is not a device");
  assert.equal(await p.identityEntry("per_bob", "e1"), null);
  const msg = pairToMessage("BOX", "dev1");
  const sig = await p.signIdentity(msg);
  assert.equal(sig.eid, "e1");
  assert.equal(sig.sig, "S:" + Buffer.from(msg).toString("base64url"));
  assert.deepEqual(await p.network.entry("e1"), { eid: "e1", kind: "device" });
  assert.equal(await p.network.entry("zz"), null);
  assert.deepEqual(await p.network.self(), { signedIn: true, name: "alex", id: "per_alex" });
  const none = identityPorts({ call: async () => { throw new Error("no spaces module"); }, space: async () => "harlow" });
  assert.equal(await none.identityEntry("per_alex", "e1"), null);
  assert.equal(await none.signIdentity(msg), null);
  assert.equal(await none.network.entry("e1"), null);
  assert.deepEqual(await none.network.self(), { signedIn: false });
  const refusing = identityPorts({ call: async () => ({ error: { code: "forbidden" } }), space: async () => "harlow" });
  assert.equal(await refusing.signIdentity(msg), null);
});

test("a directory address the guarded client refused is a refusal with its reason, not 'out of reach'; a real outage stays unreachable", async () => {
  const ports = (message, code) => identityPorts({ call: async (tool) => (tool === "spaces.identity.state" ? { data: { entries: [] } } : { error: { code, message } }), space: () => "spc_aaaaaaaaaaaa" });
  await assert.rejects(() => ports("The names directory could not be reached; wait a minute and try again. The directory address was refused: it is plain http.", "unreachable").identityEntry("per_x", "eid", "alex"), (e) => e.code === "refused" && /plain http/.test(e.message));
  await assert.rejects(() => ports("The names directory could not be reached; wait a minute and try again.", "unreachable").identityEntry("per_x", "eid", "alex"), (e) => e.code === "unreachable");
  await assert.rejects(() => ports("not allowed", "denied").identityEntry("per_x", "eid", "alex"), (e) => e.code === "failed");
});
