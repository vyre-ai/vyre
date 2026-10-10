// @ts-check
// Signing from a stage (R032-05), end to end in the Flows test world: a record entering the stage asks Documents for a signature and emails the link; the signed event moves the record on.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "../../kernel/flows/testing/world.js";
import { SPACE } from "../../kernel/flows/testing/fixtures.js";
import { catalog } from "../../kernel/flows/testing/fixtures.js";
import { signingFlow } from "./signing.js";

/** A module's event as the kernel log carries it to a wait: its facts under payload (kernel/bus.js). */
const ev = (/** @type {any} */ payload) => ({ legacy: 1, source: "appmods", at: Date.now(), project: null, thread: null, payload });
const mine = (/** @type {any} */ w, /** @type {string} */ type) => [.../** @type {Map<string, any>} */ (w.kernel.tables.get(type) || new Map()).values()];
const OPTS = { type: "matter", out_stage: "Out for signature", signed_stage: "Signed", template_id: 12, email_field: "email", name_field: "client" };

function cat() {
  const c = catalog();
  const matter = { ...c.types.matter, fields: [...c.types.matter.fields.filter((/** @type {any} */ f) => f.name !== "stage"), { name: "signature_submission", kind: "text", label: "Signature" }, { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Out for signature", "Signed"] }], stages: [{ name: "Intake" }, { name: "Out for signature" }, { name: "Signed" }] };
  return { ...c, types: { ...c.types, matter },
    actions: { ...c.actions, "documents.send": { risk: "outward.send", label: "Send a document for signature", tool: true }, "documents.send-signed": { risk: "outward.send", label: "Email the signer their signed copy", tool: true } } };
}

test("the builder refuses what it cannot make a Flow from", () => {
  assert.throws(() => signingFlow({ ...OPTS, type: "Matter!" }), /type must be/);
  assert.throws(() => signingFlow({ ...OPTS, out_stage: "" }), /name the stage/);
  assert.throws(() => signingFlow({ ...OPTS, template_id: 0 }), /template_id/);
  assert.throws(() => signingFlow({ ...OPTS, wait_days: 0 }), /wait_days/);
  const f = signingFlow(OPTS);
  assert.deepEqual(f.trigger, { on: "stage", type: "matter", stage: "Out for signature" });
  assert.equal(f.steps[1].then[1].action, "documents.send");
  assert.equal(f.steps[1].then.filter((/** @type {any} */ x) => x.kind === "call").length, 2, "two acts that leave, two yeses: the request with its link, the signed copy");
});

test("a matter entering the stage is sent for signature with one yes; the signed event moves it on; the signed copy goes by a second yes", async () => {
  /** @type {any[]} */ const calls = [];
  const w = await world({ cat: cat(), ports: {
    call: async (/** @type {any} */ _chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {any} */ input) => {
      calls.push({ action, resource, input });
      return action === "documents.send" ? { submission: 4411, slug: "abc123", url: "https://documents.harlow.vyre.run/sign/4411/abc123", sent: { held: "gi_1" } } : { url: "https://documents.harlow.vyre.run/signed/1.abc.sig", expires: 1, sent: { held: "gi_2" } };
    },
  } });
  await install(w, signingFlow(OPTS));
  const alex = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: SPACE });
  const rec = await w.kernel.records.create(alex, "matter", { client: "Dana Harlow", email: "dana@harlow.test", stage: "Intake" });
  await w.kernel.records.update(alex, "matter", rec.id, { stage: "Out for signature" }, rec.version);
  await settle(w);
  let asks = 0;
  const answer = async () => {
    for (let i = 0; i < 6; i++) {
      const held = w.kernel.tasks.filter((/** @type {any} */ x) => x.form && x.form.kind === "held_act" && x.state !== "done");
      if (!held.length) break;
      asks += held.length;
      for (const t of held) w.kernel.completeTask(t.id, { outcome: "approved" });
      await settle(w);
    }
  };
  // the request and the email that carries its link are one act: one yes, and nothing runs before it
  assert.equal(calls.length, 0, "nothing went before the yes");
  await answer();
  assert.equal(asks, 1, "one yes for the request and its link");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "documents.send");
  assert.deepEqual(calls[0].input, { template_id: 12, email: "dana@harlow.test", signer: "Dana Harlow" });
  assert.equal(mine(w, "matter")[0].data.signature_submission, "4411");
  // Documents says it was signed: the matter that asked for it moves to Signed
  w.kernel.inbound("documents.signed", ev({ submission: 4411, email: "dana@harlow.test", template: "Engagement letter", at: "2026-10-10T10:00:00Z" }));
  await settle(w);
  assert.equal(mine(w, "matter")[0].data.stage, "Signed");
  // the signed copy: a link made and emailed to the signer, one yes (it has no end unless the setting gives one)
  await answer();
  assert.equal(asks, 2, "two yeses for the whole signing");
  assert.deepEqual(calls[1], { action: "documents.send-signed", resource: "vyre://space/documents", input: { slug: "abc123", email: "dana@harlow.test" } });
  // a different submission moves nothing
  const again = mine(w, "matter")[0];
  await w.kernel.records.update(alex, "matter", again.id, { stage: "Intake" }, again.version);
  w.kernel.inbound("documents.signed", ev({ submission: 9999, email: "x@y.test", template: "T", at: "2026-10-10T11:00:00Z" }));
  await settle(w);
  assert.equal(mine(w, "matter")[0].data.stage, "Intake");
});
