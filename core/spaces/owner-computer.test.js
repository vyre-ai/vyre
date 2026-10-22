// The owner's computer asks spaces.devices.list and gets this computer, not no_identity. Facts are the daemon's own callerFacts, from relay.device.info and wink.device.record. Settings then lists this computer and the other paired computer.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start, callerFacts } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { withThisComputer } from "../../apps/app/screens/devices/this-computer.js";
import { deviceRows } from "../../apps/app/screens/devices/real.js";

test("the owner's computer lists itself and the other computer, and spaces.devices.list is not no_identity", { timeout: 120000 }, async (t) => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true });
  t.after(() => d.stop());
  const ids = { here: "bbbbbbbbbbbbbbbb", other: "cccccccccccccccc" };
  const ins = d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at, owner_paired) VALUES (?, ?, 'p', ?, 'app', 0, NULL, ?)");
  const mark = JSON.stringify({ by: "owner", at: 1, path: "marked" });
  ins.run(ids.here, "Blair's computer", 1, mark);
  ins.run(ids.other, "Juniper's computer", 2, mark);

  const rowFor = async (id) => {
    const info = await d.registry.call("relay.device.info", { id }, "module:vyred");
    const w = await d.registry.call("wink.device.record", { id }, "module:vyred");
    const row = info.data ? { ...info.data, person: w && w.data && typeof w.data.owner === "string" ? w.data.owner : null, homeOwner: Boolean(w && w.data && w.data.homeOwner) } : null;
    return callerFacts(`device:${id}`, { caller: `device:${id}` }, {}, d.kernel, false, row);
  };
  const facts = await rowFor(ids.here);
  assert.equal(facts && facts.kind, "device");
  const mine = await d.registry.call("spaces.devices.list", {}, `device:${ids.here}`, { person: { id: "ps1" }, kernelFacts: facts });
  assert.equal(mine.error, undefined, JSON.stringify(mine.error));
  assert.equal(mine.data.device.eid, ids.here);

  const localFacts = callerFacts("local", {}, null, d.kernel, false, null, { inside: false, outside: true });
  assert.equal(localFacts && localFacts.kind, "socket");
  const home = await d.registry.call("spaces.devices.list", {}, "local", { kernelFacts: localFacts });
  assert.equal(home.error, undefined, JSON.stringify(home.error));
  assert.deepEqual(home.data.device, { eid: "this-computer", label: "This computer", self: true });
  const named = await d.registry.call("spaces.devices.list", { device: ids.other }, "local", { kernelFacts: localFacts });
  assert.equal(named.error && named.error.code, "not_found", "this computer does not open another device's spaces");
  const bare = await d.registry.call("spaces.devices.list", {}, "local");
  assert.equal(bare.error && bare.error.code, "no_identity", "no facts, no answer");
  const inside = callerFacts("local", {}, null, d.kernel, false, null, { inside: true, outside: false });
  const model = await d.registry.call("spaces.devices.list", {}, "local", { kernelFacts: inside });
  assert.equal(model.error && model.error.code, "no_identity", "a call inside a model is not this computer");

  const listed = await d.registry.call("relay.devices.list", {}, "local");
  assert.equal(listed.error, undefined, JSON.stringify(listed.error));
  const rows = deviceRows(withThisComputer(listed.data));
  assert.deepEqual(rows.map((r) => r.name), ["This computer", "Blair's computer", "Juniper's computer"]);
  assert.ok(rows.every((r) => r.device === "computer"));
});
