// @ts-check
// hooks.open from a browser: with no person's yes in the call it answers presence_required with the moment and the exact request, and the card the app then asks for (approvals.ask, the request the app builds
// with heldAsk from that answer) must fit that moment. A route whose card does not fit cannot be opened from the app (the Flow editor's "Open the route" showed "that request does not fit this kind of card").
// Run in a real vyred whose presence verifier finds no one, so the floor answers as it does for a browser.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, absent } from "../../test/helpers.js";
import { heldAsk } from "../../apps/app/src/real/approvals.js";

async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  const d = await start({ presence: absent, root, log: () => {} });
  t.after(() => d.stop());
  return { d, reg: (/** @type {string} */ tool, input = {}, caller = "deck", meta = {}) => d.registry.call(tool, input, caller, meta) };
}

// A bare device: or web: label is refused by the door before any card (it is not vouched by the transport), so the person surfaces are what this test can stand in for.
const CALLERS = ["deck", "local:capsule"];
for (const caller of CALLERS) for (const [label, verify] of [["no secret named (Vyre makes it)", { scheme: "hmac-sha256", header: "x-signature" }], ["a Vault item named", { scheme: "hmac-sha256", header: "x-signature", secret: "northwind-hook" }], ["GitHub", { scheme: "github" }]]) {
  test(`hooks.open as ${caller}, ${label}: the card the app asks for fits the moment the box named`, async t => {
    const { reg } = await boot(t);
    const input = { name: "walk-orders", verify };
    const held = await reg("hooks.open", input, caller);
    assert.equal(held.error && held.error.code, "presence_required", JSON.stringify(held));
    const ask = heldAsk(held.error, "hooks.open", input);
    assert.ok(ask, `the app can see this as a held act: ${JSON.stringify(held.error)}`);
    const card = await reg("approvals.ask", { moment: ask.moment, request: ask.request }, caller);
    assert.equal(card.error, undefined, `${JSON.stringify(ask)} -> ${JSON.stringify(card.error)}`);
    assert.equal(typeof card.data.id, "string");
    assert.match(card.data.line, /hooks\/walk-orders|walk-orders/);
  });
}

test("a card that does not fit says why: the act and the kind of yes", async t => {
  const { reg } = await boot(t);
  const wrong = await reg("approvals.ask", { moment: "vault", request: { op: "hooks.open", fields: { name: "x" } } });
  assert.match(wrong.error && wrong.error.message, /does not fit this kind of card \(hooks\.open is not an act the vault yes covers\)/);
  const nested = await reg("approvals.ask", { moment: "outward", request: { op: "hooks.open", fields: { name: "x", verify: { scheme: "github" } } } });
  assert.match(nested.error && nested.error.message, /\(field verify is not a short plain value\)/);
});
