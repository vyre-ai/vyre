import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createRecordsHost } from "../host.js";
import fs from "node:fs";
const BASE = JSON.parse(fs.readFileSync(new URL("./base/kit.json", import.meta.url), "utf8"));

const SPACE = "spc_baseobjects1";
async function rig() {
  const host = createRecordsHost({ space: SPACE, owner: "per_owner", store: createMemoryStore() });
  await host.defineCore();
  await host.installKit(BASE);
  const R = host.kernel.records, o = host.ownerChain();
  return { host, R, o };
}

test("the base Kit installs on a Space and the types are there with their views stored", async () => {
  const { host } = await rig();
  const types = new Map(Object.entries(host.catalog().types));
  for (const n of ["contact", "lead", "appointment", "client", "subscriber", "project"]) assert.ok(types.has(n), n);
  assert.equal(types.get("project").views[0].groupBy, "stage");
  assert.equal(types.get("project").kind, "project");
});

test("one Contact, many roles: a person who is a Lead and then a Client is still one Contact", async () => {
  const { R, o } = await rig();
  const c = await R.create(o, "contact", { name: "Jordan Reyes", email: "jordan@example.com" });
  const lead = await R.create(o, "lead", { contact: { urn: c.urn }, stage: "New" });
  const client = await R.create(o, "client", { contact: { urn: c.urn }, stage: "Onboarding" });
  const roles = await R.roles(o, c.urn);
  assert.deepEqual(roles.map((r) => r.role).sort(), ["client", "lead"]);
  assert.ok(lead.urn && client.urn);
  await assert.rejects(() => R.create(o, "lead", { stage: "New" }), "a lead without a contact is refused");
});

// (a Project's stages by practice area moved to the Law firm Kit with the practice area itself: objects' base Kit has no legal words)
