// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ON_PHONE, needsPerson, onPhoneFor, reasonLine, softwareKeyLine } from "./on-phone.js";
import { actWords } from "./approvals.js";

test("RC1: a person-only ask in a blocked browser says to do it on the phone, for each way the box asks", () => {
  assert.equal(ON_PHONE, "Do this in Vyre on your phone.");
  for (const code of ["presence_required", "needs_presence", "needs_approval"]) assert.equal(needsPerson({ code }), true, code);
  for (const code of ["not_found", "denied", "offline", undefined]) assert.equal(needsPerson({ code }), false, String(code));
  assert.equal(needsPerson(null), false);
});

test("the browser throws on_phone before it offers a passkey, and the Vault shows no button it cannot honour", () => {
  const box = fs.readFileSync(new URL("./box.ts", import.meta.url), "utf8");
  assert.ok(box.indexOf("claimBlocked() && needsPerson(r.error)") > 0 && box.indexOf("claimBlocked() && needsPerson(r.error)") < box.indexOf("wantsPasskey(r.error)) {"));
  const v = fs.readFileSync(new URL("../../screens/vault/RealVault.tsx", import.meta.url), "utf8");
  assert.match(v, /claimBlocked\(\) \? <Text[^>]*>Reveal in Vyre on your phone/);
  assert.match(v, /claimBlocked\(\) \? <Text[^>]*>\{ON_PHONE/);
});

test("the pairing sends the claimed Vyre name as owner.vyre, only when there is one", () => {
  const p = fs.readFileSync(new URL("./pairing.ts", import.meta.url), "utf8");
  assert.match(p, /\.\.\.\(vyre \? \{ owner: \{ vyre \} \} : \{\}\)/);
});

test("a browser names what the person does on the phone", () => {
  assert.equal(onPhoneFor("seal.reveal"), "Reveal it in Vyre on your phone.");
  assert.equal(onPhoneFor("tasks.decide"), "Approve it in Vyre on your phone.");
  assert.equal(onPhoneFor("something.else"), ON_PHONE);
  assert.equal(onPhoneFor("onboard.claude"), "Connect it in Vyre on your phone.");
  assert.equal(actWords("rules.remove"), "Remove a rule");
  assert.equal(actWords("nope"), "");
});

test("the line says the method the person has: Touch ID in a Mac window, the phone elsewhere", () => {
  assert.equal(onPhoneFor("seal.reveal", "touchid"), "Reveal it with Touch ID.");
  assert.equal(onPhoneFor("seal.reveal", "phone"), "Reveal it in Vyre on your phone.");
  assert.equal(onPhoneFor("something.else", "touchid"), "Do this with Touch ID.");
  assert.equal(onPhoneFor("onboard.claude", "touchid"), "Connect it with Touch ID.");
});

test("a browser asked to unlock the personal vault says to do it on the phone", () => {
  assert.equal(onPhoneFor("vault.account.unlock-phone", "phone"), "Unlock it in Vyre on your phone.");
  assert.equal(onPhoneFor("vault.account.unlock-phone", "touchid"), "Unlock it with Touch ID.");
});

test("a phone's server pairing sends owner.pin and signs sig and esig together (one Face ID), as a hardware phone; a browser stays software with sig alone", () => {
  const p = fs.readFileSync(new URL("./pairing.ts", import.meta.url), "utf8");
  assert.match(p, /owner: \{ id: mine\.id, name: plainName\(mine\.name\), vyre: mine\.name, pin: mine\.pin \}/);
  assert.match(p, /signListChange\(m, /);
  assert.match(p, /esig: toB64u\(esig\)/);
  assert.match(p, /deviceKind: phoneKeys \? "phone" : "web", keyStorage: phoneKeys \? "hardware" : "software"/);
  assert.match(p, /kind === "secure-enclave" \|\| kind === "keystore"/);
});

test("a proof made with a software key says to approve on the phone, in our words, and tool() maps the code before the generic throw", () => {
  assert.equal(softwareKeyLine("phone"), "Approve this in Vyre on your phone.");
  assert.equal(softwareKeyLine("touchid"), "Approve this with Touch ID.");
  const box = fs.readFileSync(new URL("./box.ts", import.meta.url), "utf8");
  const i = box.indexOf('r.error?.code === "software_key"');
  assert.ok(i > 0 && i < box.indexOf('if (r.error) throw new BoxError(r.error.code'), "the software_key mapping comes first");
  assert.ok(!box.includes("r.error.message ?? \"\"); // software"), "the server's text is not shown for it");
});

test("each verifier reason has our own sentence, an unknown one has none", () => {
  for (const r of ["no_proof", "wrong_decision", "wrong_payload", "unknown_key", "bad_signature", "expired", "replayed", "software_key", "needs_bind", "unavailable", "refused"]) {
    const line = reasonLine(r, "phone");
    assert.ok(line && !/[\u2014]/.test(line), r);
  }
  assert.equal(reasonLine("expired", "phone"), "That approval ran out. Approve it again.");
  assert.equal(reasonLine("software_key", "touchid"), "Approve this with Touch ID.");
  assert.equal(reasonLine("surprise", "phone"), null);
});

test("making a space on the server from a browser says to do it on the phone", () => {
  assert.equal(onPhoneFor("spaces.host-here", "phone"), "Make this space in Vyre on your phone.");
  assert.equal(onPhoneFor("spaces.host-here", "touchid"), "Make this space with Touch ID.");
});
