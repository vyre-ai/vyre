// @ts-check
// `approval` is the envelope key a held act's retry carries (the registry takes it out of the input before any tool sees it, ruling c328cd1 / one yes). A tool that declared its own input named `approval`
// would silently lose it, so no tool may: this fails if any tool's schema declares one.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("no tool declares an input named `approval`: the key is the envelope's", { timeout: 60_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true });
  t.after(() => d.stop());
  // Two vault tools already take an input of their own named `approval` (a vault approval id, not a card). The registry leaves a declared `approval` input alone (it is read from the header only for them),
  // so they keep working; this list is closed: a new tool may not join it.
  const OWN = new Set(["vault.service.forward", "vault.device.join"]);
  const bad = [];
  for (const [name, def] of d.registry.tools) if (def && def.input && def.input.properties && Object.hasOwn(def.input.properties, "approval") && !OWN.has(name)) bad.push(name);
  assert.deepEqual(bad, [], `these tools declare an input called approval: ${bad.join(", ")}`);
  for (const name of OWN) { const def = d.registry.tools.get(name); assert.ok(def && def.input.properties.approval, `${name} still declares its own approval input`); }
  assert.ok(d.registry.tools.size > 100, "the real tool list was read");
});
