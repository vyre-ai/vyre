// @ts-check
// Signing from a stage (R032-05), end to end in the Flows test world: a record entering the stage asks Documents for a signature and emails the link; the signed event moves the record on.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "../../kernel/flows/testing/world.js";
import { SPACE } from "../../kernel/flows/testing/fixtures.js";
import { catalog } from "../../kernel/flows/testing/fixtures.js";
import { signingFlow } from "./signing.js";

const mine = (/** @type {any} */ w, /** @type {string} */ type) => [.../** @type {Map<string, any>} */ (w.kernel.tables.get(type) || new Map()).values()];
const OPTS = { type: "matter", out_stage: "Out for signature", signed_stage: "Signed", template_id: 12, email_field: "email", name_field: "client", base: "https://harlow.vyre.run/" };

function cat() {
  const c = catalog();
  const matter = { ...c.types.matter, fields: [...c.types.matter.fields.filter((/** @type {any} */ f) => f.name !== "stage"), { name: "signature_submission", kind: "text", label: "Signature" }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Out for signature", "Signed"] }], stages: [{ name: "Intake" }, { name: "Out for signature" }, { name: "Signed" }] };
  return { ...c, types: { ...c.types, matter },
    actions: { ...c.actions, "comms.send": { risk: "outward.send", label: "Send an email or a text", tool: true } },
    connectors: { ...c.connectors, "conn-documents": { allow: [{ method: "GET", path: "/api/*" }, { method: "POST", path: "/api/submissions" }], operations: { "submissions.create": { method: "POST", path: "/api/submissions", kind: "send", input: { body: { template_id: { type: "number" }, send_email: { type: "boolean" }, submitters: { type: "array" } }, encoding: "json" } } } } } };
}

test("the builder refuses what it cannot make a Flow from", () => {
  assert.throws(() => signingFlow({ ...OPTS, type: "Matter!" }), /type must be/);
  assert.throws(() => signingFlow({ ...OPTS, out_stage: "" }), /name the stage/);
  assert.throws(() => signingFlow({ ...OPTS, template_id: 0 }), /template_id/);
  assert.throws(() => signingFlow({ ...OPTS, base: "javascript:1" }), /base is the address/);
  assert.throws(() => signingFlow({ ...OPTS, wait_days: 0 }), /wait_days/);
  const f = signingFlow(OPTS);
  assert.deepEqual(f.trigger, { on: "stage", type: "matter", stage: "Out for signature" });
  assert.equal(f.steps[1].then[3].input.body.expr.includes("https://harlow.vyre.run/sign/"), true);
});

test("a matter entering the stage gets a signing request and its link by email; the signed event moves it on", async () => {
  /** @type {any[]} */ const services = [], calls = [];
  const w = await world({ cat: cat(), ports: {
    service: async (/** @type {any} */ q) => { services.push(q); const json = [{ id: 7, submission_id: 4411, slug: "abc123", email: "dana@harlow.test" }]; return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(json)).toString("base64") }; },
    call: async (/** @type {any} */ _chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {any} */ input) => { calls.push({ action, resource, input }); return { held: "gi_1" }; },
  } });
  await install(w, signingFlow(OPTS));
  const alex = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
  const rec = await w.kernel.records.create(alex, "matter", { client: "Dana Harlow", email: "dana@harlow.test", stage: "Intake" });
  await w.kernel.records.update(alex, "matter", rec.id, { stage: "Out for signature" }, rec.version);
  await settle(w);
  // the signing request and the email are outward: each waits for the person's yes, and runs once it is given
  for (let i = 0; i < 6; i++) {
    const held = w.kernel.tasks.filter((/** @type {any} */ x) => x.form && x.form.kind === "held_act" && x.state !== "done");
    if (!held.length) break;
    for (const t of held) w.kernel.completeTask(t.id, { outcome: "approved" });
    await settle(w);
  }
  assert.equal(services.length, 1, "one signing request");
  assert.deepEqual(services[0].request.body, { template_id: 12, send_email: false, submitters: [{ email: "dana@harlow.test", name: "Dana Harlow" }] });
  assert.equal(mine(w, "matter")[0].data.signature_submission, "4411");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "comms.send");
  assert.equal(calls[0].input.to, "dana@harlow.test");
  assert.equal(calls[0].input.body, "Your document is ready to sign: https://harlow.vyre.run/sign/4411/abc123");
  void rec;
  // Documents says it was signed: the matter that asked for it moves to Signed
  w.kernel.inbound("documents.signed", { submission: 4411, email: "dana@harlow.test", template: "Engagement letter", at: "2026-10-10T10:00:00Z" });
  await settle(w);
  assert.equal(mine(w, "matter")[0].data.stage, "Signed");
  // a different submission moves nothing
  const again = mine(w, "matter")[0];
  await w.kernel.records.update(alex, "matter", again.id, { stage: "Intake" }, again.version);
  w.kernel.inbound("documents.signed", { submission: 9999, email: "x@y.test", template: "T", at: "2026-10-10T11:00:00Z" });
  await settle(w);
  assert.equal(mine(w, "matter")[0].data.stage, "Intake");
});
