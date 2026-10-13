// @ts-check
// A device that came in on the identity chain and is LIMITED (a newcomer under 24 hours, a relay-held key, a GitHub-added device nobody confirmed) uses, sends, approves and holds presence, but is refused the acts only
// a full device does: pairing and confirming devices, marking or removing them, ownership, another device's presence key, the identity's own list. ONE gate at the registry's entry (limited-gate), ONE list
// (DEVICE_ADMIN), and a drift test so a new device-admin tool has to be placed on purpose.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_ADMIN, DEVICE_OK, ADMIN_SHAPE, createLimitedGate } from "./device-admin.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Every declared tool and who may reach it, from the modules' own manifests. */
const tools = () => {
  /** @type {Array<[string, string]>} */ const out = [];
  for (const d of fs.readdirSync(CORE, { withFileTypes: true })) {
    const f = path.join(CORE, d.name, "module.json");
    if (!d.isDirectory() || !fs.existsSync(f)) continue;
    for (const t of JSON.parse(fs.readFileSync(f, "utf8")).does?.tools ?? []) out.push([typeof t === "string" ? t : t.name, typeof t === "string" ? "person" : t.reach ?? "person"]);
  }
  return out;
};

test("every name on either list is a real tool", () => {
  const real = new Set(tools().map(([n]) => n));
  for (const n of [...DEVICE_ADMIN, ...DEVICE_OK]) assert.ok(real.has(n), `${n} is not a tool any more: take it off the list`);
});

test("every tool a device can reach that has the shape of device administration is on exactly one list, on purpose", () => {
  const drift = tools().filter(([n, reach]) => reach !== "modules" && ADMIN_SHAPE.test(n)).map(([n]) => n).filter((n) => DEVICE_ADMIN.has(n) === DEVICE_OK.has(n));
  assert.deepEqual(drift, [], "place each of these on DEVICE_ADMIN (refused to a limited device) or DEVICE_OK (with the reason in the comment)");
});

test("a limited chain device is refused every device-admin tool, in words that name the next step", async () => {
  const gate = createLimitedGate({ isLimited: async (/** @type {string} */ id) => id === "limited123456789" });
  for (const tool of DEVICE_ADMIN) {
    const r = await gate(tool, "device:limited123456789", true);
    assert.equal(r?.error?.code, "denied", tool);
    assert.match(r?.error?.message ?? "", /from your first device|24 hours/, `${tool} names the next step`);
  }
});

test("a full device, a device with no chain fact, and a non-device caller are not refused", async () => {
  const gate = createLimitedGate({ isLimited: async (/** @type {string} */ id) => id === "limited123456789" });
  for (const tool of DEVICE_ADMIN) {
    assert.equal(await gate(tool, "device:full1234567890ab", true), null, tool);
    assert.equal(await gate(tool, "cli", false), null, tool);
    assert.equal(await gate(tool, "module:wink", false), null, tool);
  }
});

test("a limited device still uses the box: tools on DEVICE_OK and ordinary tools pass the gate", async () => {
  const gate = createLimitedGate({ isLimited: async () => true });
  for (const tool of [...DEVICE_OK, "records.list", "stream.send", "approvals.answer", "vault.list"]) assert.equal(await gate(tool, "device:limited123456789", true), null, tool);
});

test("a gate that cannot tell fails closed for the admin tools", async () => {
  const gate = createLimitedGate({ isLimited: async () => { throw new Error("db"); } });
  assert.equal((await gate("relay.devices.remove", "device:abc", true))?.error?.code, "denied");
  assert.equal(await gate("records.list", "device:abc", true), null, "and still lets ordinary tools through");
});

test("a device label with no valid id is REFUSED for a device-admin tool, not skipped (fail closed), and still passes ordinary tools", async () => {
  const gate = createLimitedGate({ isLimited: async () => false });
  for (const odd of ["device:" + "a".repeat(70), "device:a b", "device:", "device:has/slash"]) {
    for (const tool of DEVICE_ADMIN) {
      const r = await gate(tool, odd, true);
      assert.equal(r?.error?.code, "denied", `${odd.slice(0, 20)} ${tool}`);
    }
    assert.equal(await gate("records.list", odd, true), null, "an ordinary tool is not this gate's");
  }
});

test("the registry tells the gate the caller is a device", () => {
  const src = fs.readFileSync(path.join(CORE, "modules", "index.js"), "utf8");
  assert.match(src, /this\.deps\.limitedGate\(tool, String\(caller\), true\)/);
});
