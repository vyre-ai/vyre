// @ts-check
// The person's own switches (Settings > Privacy): confirm.pairing, confirm.vault, confirm.outward. Default on; with one off, that person's OWN call for that moment needs no yes, and nobody else's changes.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, absent } from "../../test/helpers.js";

/** `absent`, except that it says yes while `open.on` (so an item can be put first, as a person with a proof would). */
const gate = { on: false };
const sometimes = { ...absent, verify: async (/** @type {any} */ ...a) => (gate.on ? { ok: true, method: "test" } : /** @type {any} */ (absent).verify(...a)) };

async function world(t, confirm) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" }, ...(confirm ? { confirm } : {}) }));
  const d = await start({ presence: sometimes, root, log: () => {} });
  t.after(() => d.stop());
  return d;
}
const reveal = (/** @type {any} */ d, /** @type {string} */ caller) => d.registry.call("vault.reveal", { name: "harlow-login", field: "value" }, caller);

test("confirm.vault: on by default (a reveal asks), and off lets the person's own reveal through but never a model's or a module's", async t => {
  const on = await world(t, undefined);
  const asked = await reveal(on, "local");
  assert.equal(asked.error && asked.error.code, "presence_required", JSON.stringify(asked));

  const off = await world(t, { vault: false });
  // The item has to exist: put is a vault moment too, and with the switch off it goes straight through for the person.
  gate.on = true;
  assert.equal((await off.registry.call("vault.put", { name: "harlow-login", value: "s3cret-value" }, "local")).error, undefined);
  gate.on = false;
  const shown = await reveal(off, "local");
  assert.equal(shown.data && shown.data.value, "s3cret-value", JSON.stringify(shown));
  for (const caller of ["mcp", "mcp:agent:kit", "harness", "module:x"]) {
    const r = await reveal(off, caller);
    assert.ok(r.error && !JSON.stringify(r).includes("s3cret-value"), `${caller}: ${JSON.stringify(r)}`);
  }
  // Another moment's switch stays on: with only the pairing switch off, a reveal still asks.
  const pairOff = await world(t, { pairing: false });
  assert.equal((await reveal(pairOff, "local")).error?.code, "presence_required");
});
