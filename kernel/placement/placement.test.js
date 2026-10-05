import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { placeWorkload, nodeBlock, checkDescriptor, signDescriptor, verifyDescriptor, newNodeKey } from "./index.js";

const mk = (id, kind, extra = {}) => {
  const k = newNodeKey();
  return signDescriptor({ id, name: id, kind, capabilities: ["compute", "browser"], resources: { cpus: 8, memMb: 16000 }, residency: ["us"], posture: { diskEncrypted: true }, lend: {}, key: k.key, ...extra }, k.secret);
};
const yes = { spaceAllows: true, nodeHosts: true };
const calm = { online: true, awake: true, onPower: true, cpuPct: 10, memPct: 20 };
const space = "harlow";

test("a descriptor is signed by its node key and a changed record fails", () => {
  const d = mk("laptop", "device");
  assert.ok(verifyDescriptor(d));
  assert.ok(!verifyDescriptor({ ...d, capabilities: [...d.capabilities, "gpu"] }), "an edited record no longer verifies");
  assert.ok(!verifyDescriptor({ ...d, sig: undefined }));
  assert.throws(() => checkDescriptor({ ...d, capabilities: ["teleport"] }), /capabilities/);
});

test("placement picks the requester's own node, and says what it passed over", () => {
  const events = [];
  const laptop = mk("laptop", "device"), srv = mk("srv", "server");
  const r = placeWorkload({ space, workload: { id: "w1", at: "laptop" }, emit: (t, d) => events.push([t, d]),
    nodes: [{ descriptor: srv, status: calm, consent: yes }, { descriptor: laptop, status: calm, consent: yes }] });
  assert.equal(r.node, "laptop");
  assert.equal(events[0][0], "workload.placed");
  assert.equal(events[0][1].node, "laptop");
});

test("two-way consent: either side missing keeps the workload off the node", () => {
  const laptop = mk("laptop", "device");
  const a = placeWorkload({ space, workload: {}, nodes: [{ descriptor: laptop, status: calm, consent: { spaceAllows: false, nodeHosts: true } }] });
  assert.equal(a.code, "space_policy");
  const b = placeWorkload({ space, workload: {}, nodes: [{ descriptor: laptop, status: calm, consent: { spaceAllows: true, nodeHosts: false } }] });
  assert.equal(b.code, "lend_policy");
  const lent = mk("lent", "device", { lend: { spaces: ["other"] } });
  assert.equal(placeWorkload({ space, workload: {}, nodes: [{ descriptor: lent, status: calm, consent: yes }] }).code, "lend_policy", "the lend policy names Spaces");
  assert.equal(placeWorkload({ space, workload: {}, policy: { memberCompute: false }, nodes: [{ descriptor: laptop, status: calm, consent: yes }] }).code, "space_policy");
});

test("capability, resource, residency and posture filters give plain reasons", () => {
  const n = (d, st = calm) => ({ descriptor: d, status: st, consent: yes });
  const srv = mk("srv", "server");
  assert.match(placeWorkload({ space, workload: { requires: { capabilities: ["gpu"] } }, nodes: [n(srv)] }).reasons[0].reason, /does not offer gpu/);
  assert.match(placeWorkload({ space, workload: { requires: { memMb: 64000 } }, nodes: [n(srv)] }).reasons[0].reason, /16000 MB/);
  assert.equal(placeWorkload({ space, workload: { requires: { residency: ["eu"] } }, nodes: [n(srv)] }).code, "residency");
  assert.equal(placeWorkload({ space, policy: { residency: ["eu"] }, workload: {}, nodes: [n(srv)] }).code, "residency", "the Space's own residency rule applies too");
  const open = mk("open", "device", { posture: { diskEncrypted: false } });
  assert.equal(placeWorkload({ space, workload: {}, nodes: [n(open)] }).code, "posture");
});

test("a lend policy's limits apply to a device and not to a server", () => {
  const laptop = mk("laptop", "device"), srv = mk("srv", "server");
  const run = st => placeWorkload({ space, workload: {}, nodes: [{ descriptor: laptop, status: st, consent: yes }] });
  assert.equal(run({ ...calm, onPower: false }).code, "battery");
  assert.equal(run({ ...calm, cpuPct: 95 }).code, "busy");
  assert.equal(run({ ...calm, memPct: 95 }).code, "memory");
  assert.equal(run({ ...calm, awake: false }).code, "asleep");
  assert.equal(placeWorkload({ space, workload: {}, nodes: [{ descriptor: srv, status: { ...calm, onPower: false, cpuPct: 99 }, consent: yes }] }).placed, true);
});

test("pinned to the server, an offline or full server refuses; unsigned records decide nothing", () => {
  const laptop = mk("laptop", "device"), srv = mk("srv", "server");
  const pinned = (st, full) => placeWorkload({ space, workload: { pinnedTo: "server", at: "laptop" }, nodes: [{ descriptor: laptop, status: calm, consent: yes }, { descriptor: srv, status: st, consent: yes, full }] });
  assert.equal(pinned(calm).node, "srv");
  assert.equal(pinned({ online: false }).code, "pinned");
  assert.equal(pinned(calm, true).placed, false);
  const events = [];
  const r = placeWorkload({ space, workload: { id: "w2" }, emit: (t, d) => events.push([t, d]), nodes: [{ descriptor: { ...srv, capabilities: ["compute", "gpu"] }, status: calm, consent: yes }] });
  assert.equal(r.placed, false);
  assert.equal(r.reasons[0].code, "unsigned");
  assert.equal(events[0][0], "workload.refused");
  assert.equal(events[0][1].code, "unsigned");
});

test("with nothing to run on, the refusal says so; the preferred node beats an emptier one", () => {
  assert.equal(placeWorkload({ space, workload: {}, nodes: [] }).code, "no_nodes");
  const a = mk("a", "server"), b = mk("b", "server");
  const r = placeWorkload({ space, workload: { prefers: { node: "b" } }, nodes: [{ descriptor: a, status: { ...calm, cpuPct: 0, memPct: 0 }, consent: yes }, { descriptor: b, status: { ...calm, cpuPct: 50 }, consent: yes }] });
  assert.equal(r.node, "b");
  assert.equal(nodeBlock({ descriptor: a, status: calm, consent: yes, notReady: "the sandbox is missing" }, {}, { space }).code, "not_ready");
});
