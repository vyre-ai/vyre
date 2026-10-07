// forms' own tests, on the SDK's testing harness: no vyred, a temp home, and a fake kernel that holds `ctx.kernel.records` to what needs.kernel declared.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testModule } from "../../../packages/module-sdk/testing.js";

const DIR = fileURLToPath(new URL(".", import.meta.url));
async function forms(t) { const h = await testModule(DIR); t.after(() => h.stop()); return h; }

test("forms.submit files a lead, says only that one arrived, and only the webhook route may call it", async t => {
  const h = await forms(t);
  const r = await h.call("forms.submit", { name: "Dana Reyes", email: "dana@harlow.test", message: "my landlord changed the locks" }, { who: "hook" });
  assert.deepEqual(r.data, { received: true });
  const leads = await h.call("forms.leads", {});
  assert.equal(leads.data.count, 1);
  assert.deepEqual(leads.data.leads[0].name, "Dana Reyes");
  assert.deepEqual(h.events.map(e => e.type), ["forms.answer-received"]);
  assert.ok(!JSON.stringify(h.events).includes("Dana") && !JSON.stringify(h.events).includes("locks"), "the event carries nothing the person typed");
  for (const who of ["person", "agent"]) assert.equal((await h.call("forms.submit", { name: "x", email: "x@y.zz" }, { who })).error.code, "no_such_tool", `${who} cannot reach the webhook tool`);
});

test("forms.submit refuses a bad answer and a type it did not declare", async t => {
  const h = await forms(t);
  assert.equal((await h.call("forms.submit", { name: "Dana", email: "not an address" }, { who: "hook" })).error.code, "bad_input");
  assert.equal((await h.call("forms.submit", { name: "Dana", email: "d@x.zz", extra: 1 }, { who: "hook" })).error.code, "bad_input");
  await assert.rejects(() => h.ctx.kernel.records.create("contact", { name: "x" }), { code: "undeclared" });
  assert.equal(h.ctx.kernel.records.define, undefined, "no defining types");
});
