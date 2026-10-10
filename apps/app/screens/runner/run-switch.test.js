// The "Run on this computer" switch is one yes (the lending ruling: no Touch ID per lease): turning it on lends this computer to the spaces it is in, which is the one approval, and then
// lets sessions run here; turning it off stops it first and never asks. Against a fake box that answers like spaces.devices.list, spaces.devices.lend and runner.settings.set.
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runnerSource } from "./runner-source.ts";
import { lendPlan, switchNote, DEFAULT_SETTINGS } from "./runner-model.js";

const LIST = { device: { eid: "dev_mac", label: "Dana's MacBook", self: true }, spaces: [
  { space: "spc_home", name: "home", label: "home", role: "owner", enrolled: true, removed: false, lent: false, home: true },
  { space: "spc_acme", name: "Acme", role: "member", enrolled: true, removed: false, lent: true },
  { space: "spc_old", name: "Old", role: "member", enrolled: false, removed: true, lent: false },
  { space: "spc_new", name: "Studio", role: "owner", enrolled: true, removed: false, lent: false },
] };

const box = (over = {}) => {
  const calls = /** @type {{ tool: string, input: any }[]} */ ([]);
  const answers = /** @type {Record<string, any>} */ ({ "spaces.devices.list": LIST, "spaces.devices.lend": { lent: true }, "runner.settings.set": { ...DEFAULT_SETTINGS, enabled: true }, ...over });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    calls.push({ tool, input });
    const a = answers[tool];
    if (typeof a === "function") return a(input);
    return tool in answers ? { data: a } : { error: { code: "no_such_tool", message: "no" } };
  };
  return { calls, src: runnerSource(/** @type {any} */ (call)) };
};

test("run switch: the plan lends to the spaces this computer is in and not yet lent to, and stops the lent ones", () => {
  const p = lendPlan(LIST);
  assert.equal(p.device, "dev_mac");
  assert.deepEqual(p.toLend.map((s) => s.space), ["spc_home", "spc_new"]);
  assert.deepEqual(p.lent.map((s) => s.space), ["spc_acme"]);
  assert.deepEqual(lendPlan(null), { device: "", toLend: [], lent: [] }, "a box with no answer plans nothing");
});

test("run switch: turning on lends to each space (the one yes) and only then lets sessions run here", async () => {
  const { calls, src } = box();
  const r = await src.turnOn();
  assert.deepEqual(calls.map((c) => c.tool), ["spaces.devices.list", "spaces.devices.lend", "spaces.devices.lend", "runner.settings.set"]);
  assert.deepEqual(calls[1].input, { space: "spc_home", device: "dev_mac", on: true });
  assert.deepEqual(calls[2].input, { space: "spc_new", device: "dev_mac", on: true });
  assert.equal(calls[3].input.enabled, true);
  assert.equal(r.settings.enabled, true);
  assert.equal(r.lentTo.length, 3, "the space it was already lent to counts too");
});

test("run switch: a yes that is not given leaves it off and says so", async () => {
  const { calls, src } = box({ "spaces.devices.lend": () => ({ error: { code: "presence_required", message: "Approve on this device." } }) });
  await assert.rejects(src.turnOn(), /Not turned on: it needs your approval/);
  assert.ok(!calls.some((c) => c.tool === "runner.settings.set"), "nothing was switched on");
});

test("run switch: a computer in no space cannot be turned on, in words", async () => {
  const { calls, src } = box({ "spaces.devices.list": { device: { eid: "dev_mac" }, spaces: [] } });
  await assert.rejects(src.turnOn(), /not in any space/i);
  assert.ok(!calls.some((c) => c.tool === "runner.settings.set"));
});

test("run switch: turning off stops it first, then ends the lending, and never asks", async () => {
  const { calls, src } = box({ "runner.settings.set": { ...DEFAULT_SETTINGS, enabled: false } });
  const r = await src.turnOff();
  assert.deepEqual(calls.map((c) => c.tool), ["runner.settings.set", "spaces.devices.list", "spaces.devices.lend"]);
  assert.equal(calls[0].input.enabled, false);
  assert.deepEqual(calls[2].input, { space: "spc_acme", device: "dev_mac", on: false });
  assert.deepEqual([r.settings.enabled, r.failed], [false, 0]);
});

test("run switch: a stop that fails to end the lending still leaves it off, and counts what is left", async () => {
  const { src } = box({ "runner.settings.set": { ...DEFAULT_SETTINGS, enabled: false }, "spaces.devices.lend": () => ({ error: { code: "x", message: "later" } }) });
  const r = await src.turnOff();
  assert.deepEqual([r.settings.enabled, r.failed], [false, 1]);
});

test("run switch: the note under the switch names where it is shared and what happens when it is turned off", () => {
  const on = { ...DEFAULT_SETTINGS, enabled: true };
  assert.match(switchNote(on, ["Acme", "Studio"]), /Shared with Acme and Studio\./);
  assert.match(switchNote(on, []), /^Sessions may run on this Mac/);
  assert.match(switchNote({ ...DEFAULT_SETTINGS, enabled: false }), /You approve once/);
  assert.match(switchNote({ ...DEFAULT_SETTINGS, enabled: false }), /Turn it off any time/);
});
