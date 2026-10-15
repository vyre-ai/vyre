// @ts-check
// records.address-kind: what an address is, answered from the type definitions only. A record type a person made with a kind's name ("tag") makes that address a record, not the kind; a row's data is never read or returned.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("an address is a record when the Space has its own type of that name; the answer holds nothing from any row", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const K = d.kernel, space = K.space;
  const owner = K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: K.id.owner, path: "direct", session: "s" });
  const kind = async (/** @type {string} */ urn) => { const r = await d.registry.call("records.address-kind", { urn }, "module:sessions"); assert.ok(!r.error, JSON.stringify(r.error)); return r.data; };
  assert.deepEqual(await kind(`vyre://${space}/tag/t_1`), { kind: "tag" }, "no type of that name: the kind of thing it names");
  assert.deepEqual(await kind(`vyre://${space}/person/p_1`), { kind: "person" });
  await K.gateway.records.define(owner, { add_types: [{ name: "tag", label: "Tag", fields: [{ name: "label", kind: "text", label: "Label" }, { name: "secret", kind: "text", label: "Secret" }] }] });
  await K.gateway.records.create(owner, "tag", { label: "Visible", secret: "do-not-leak-4471" });
  const a = await kind(`vyre://${space}/tag/t_1`);
  assert.deepEqual(a, { kind: "record", record_type: "tag" }, "the Space's own type of that name makes it a record");
  assert.ok(!JSON.stringify(a).includes("do-not-leak-4471") && !JSON.stringify(a).includes("Visible"), "nothing from a row");
  assert.deepEqual(await kind(`vyre://${space}/person/p_1`), { kind: "person" }, "other kinds are untouched");
  assert.deepEqual(await kind("not an address"), { kind: "record" }, "what cannot be read takes no shortcut");
  // a person's own surface cannot ask: it is the composer's tool
  const { call } = await import("../daemon/client.js");
  const asPerson = await call("records.address-kind", { urn: `vyre://${space}/tag/t_1` }, { root, caller: "cli" });
  assert.ok(asPerson.error, "only a module asks");
});
