// @ts-check
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ON_PHONE, needsPerson, onPhoneFor } from "./on-phone.js";
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
