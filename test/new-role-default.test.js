// @ts-check
// A new role made from the New role dialog, with no change, is always accepted. The dialog starts a role from Member (apps/app/screens/roles/model.js starting) and sends its switches as they are;
// the box refuses a switch wider than the base (lib/roles/definition.js), so a default that holds one made it impossible to make any role at all ("Use the shared drive" is wider than a role that starts
// from Member, on the owner's live walk of v0.6.1). This holds the dialog's default to the box's own table for every base a custom role may start from, and the screen's fallback list of switches
// only an admin may hold to the catalogue's.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { checkRole } from "../lib/roles/definition.js";
import { CAN, CUSTOM_BASES } from "../lib/roles/catalogue.js";
import { ADMIN_ONLY, builtInRoles, newRole, starting } from "../apps/app/screens/roles/model.js";
import { bodyOf, rolesSource } from "../apps/app/screens/roles/source.js";

test("the New role dialog's default is accepted by the box for every base a custom role may start from", () => {
  assert.deepEqual([...CUSTOM_BASES], ["member"], "the bases the box takes (add a base here and it is held to the same rule)");
  for (const base of CUSTOM_BASES) {
    const made = newRole(base, "TestRole", builtInRoles());
    const body = bodyOf(made);
    assert.ok(body.can.length, "the default turns something on");
    assert.doesNotThrow(() => checkRole({ id: made.id, label: made.name, base, ...body }), `a ${base}-based role made with no change is accepted`);
  }
});

test("a new role never starts with a switch only an admin may hold, and the screen's fallback list is the catalogue's", () => {
  const want = CAN.filter(c => c.needs === "admin").map(c => c.id).sort();
  assert.deepEqual([...ADMIN_ONLY].sort(), want, "ADMIN_ONLY in the app is the catalogue's admin-only switches");
  const on = Object.entries(starting("member").can).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(on.filter(k => ADMIN_ONLY.includes(k)), [], "the default holds none of them");
});

test("the dialog makes a role from the Space's own record types, so a Space with no invoice type is not refused for one", async () => {
  const types = [{ name: "contact", fields: [{ name: "name" }] }, { name: "organization", fields: [{ name: "name" }] }];
  /** @type {any} */ let made = null;
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (tool === "records.types") return { data: { types } };
    if (tool === "roles.create") { made = input.role; return { data: { role: { ...input.role, builtin: false } } }; }
    return { data: [] };
  };
  await rolesSource(call).create("member", "TestRole");
  assert.ok(made, "the dialog asked the box to make the role");
  assert.deepEqual(Object.keys(made.data).sort(), ["contact", "organization"], "the role names only the Space's own types");
  assert.doesNotThrow(() => checkRole(made, { types }), "and the box takes it");
});
