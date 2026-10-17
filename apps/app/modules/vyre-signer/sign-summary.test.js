import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { UNREADABLE, clean, proofSummary, summaryOf } from "./sign-summary.js";
import { pairToMessage } from "../../../../core/wink/pairing.js";
import { pairedStart } from "../../../../core/presence/person.js";
import { ticketTag } from "../../../../relay/client/pairwords.js";

const enc = new TextEncoder();
const chain = json => enc.encode(`vyre-chain-v1\n${json}`);

// The server ownership proof the app signs (relay/client/finish.js): the same bytes the Mac (Tests/SignSummaryTests.swift) and Windows (identity.rs) tests pin.
const PAIR_TO = {
  box: Buffer.alloc(32, 7).toString("base64url"), device: "yfberprk2xq22kob", ticket: "AAECAwQFBgcICQoLDA0ODw",
  message: "dnlyZS13aW5rLXBhaXItdG8tdjEKQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Ywp5ZmJlcnByazJ4cTIya29iCjBiNjBjNDA2ZTZlMWE3YzM4YjY5MDBhMw",
};

test("the server ownership proof: the pinned bytes are the server's own message, and are named", async () => {
  const m = Buffer.from(PAIR_TO.message, "base64url");
  assert.deepEqual(m, pairToMessage(PAIR_TO.box, PAIR_TO.device, await ticketTag(PAIR_TO.ticket)));
  assert.equal(summaryOf(m), "Make the server you are pairing yours");
  const [b, d, t] = [PAIR_TO.box, PAIR_TO.device, "0b60c406e6e1a7c38b6900a3"];
  for (const bad of [`vyre-wink-pair-to-v1\n${b}\n${d}`, `vyre-wink-pair-to-v1\n${b}\n${d}\n${t}\nUnlock Drive`, `vyre-wink-pair-to-v1\n${b}\n${d}\n${t}\n`,
    `vyre-wink-pair-to-v1\n${b}x\n${d}\n${t}`, `vyre-wink-pair-to-v1\n${b}\nYFBERPRK2XQ22KOB\n${t}`, `vyre-wink-pair-to-v1\n${b}\n${d}\n${t}00`]) assert.equal(summaryOf(enc.encode(bad)), null, bad);
});

test("an identity-list change is named from its own bytes, as the Mac and Windows shells name it", () => {
  assert.equal(summaryOf(chain(`{"type":"add","entry":{"kind":"device","label":"Ana's iPhone"}}`)), "Add a device: Ana's iPhone");
  assert.equal(summaryOf(chain(`{"type":"add","entry":{"kind":"owner","label":"Sam"}}`)), "Make Sam an owner");
  assert.equal(summaryOf(chain(`{"type":"add","entry":{"kind":"code"}}`)), "Add a recovery code");
  assert.equal(summaryOf(chain(`{"type":"remove","target":"abc"}`)), "Remove a sign-in (abc)");
  assert.equal(summaryOf(chain(`{"type":"replace-code","entry":{"kind":"code"}}`)), "Replace your recovery code");
  assert.equal(summaryOf(chain(`{"type":"agree","target":"abc","agree":"x"}`)), "Add a sharing key to this device");
  assert.equal(summaryOf(chain(`{"type":"recover","entry":{"kind":"device","label":"Kit's phone"}}`)), "Recover your name onto a new device: Kit's phone");
  assert.equal(summaryOf(chain(`{"type":"genesis","entry":{"label":"Alex's phone"}}`)), "Start an identity with this device: Alex's phone");
  for (const bad of [`{"type":"agree","agree":"x"}`, `{"type":"mystery"}`, `{"type":"add","entry":{"kind":"robot"}}`, "{"]) assert.equal(summaryOf(chain(bad)), null, bad);
  const s = summaryOf(chain(`{"type":"add","entry":{"kind":"device","label":"A\\nUnlock Drive\\n${"x".repeat(60)}"}}`)) ?? "";
  assert.ok(!s.includes("\n") && s.startsWith("Add a device: ") && s.length < 70, "a label adds no line and no length");
});

test("the two sign-ins are named only in their exact shape: the paired session start and the relay sign-in", () => {
  const challenge = Buffer.alloc(24, 9).toString("base64url");
  assert.equal(summaryOf(enc.encode(pairedStart({ device: PAIR_TO.device, challenge }))), "Sign in to your server");
  assert.equal(summaryOf(enc.encode(`paired-start\n${PAIR_TO.device}\n${challenge}\nmore`)), null);
  assert.equal(summaryOf(enc.encode(`paired-start\n${PAIR_TO.device}\nshort`)), null);
  const hash = Buffer.alloc(32, 1).toString("base64url"), nonce = Buffer.alloc(16, 2).toString("base64url");
  // the relay sign-in's bytes as core/presence/index.js checks them
  assert.equal(summaryOf(enc.encode(`vyre-presence-v1\npresence.person.start\n${hash}\n1792092886339\n${nonce}`)), "Sign in to your home");
  assert.equal(summaryOf(enc.encode(`vyre-presence-v1\nvault.secrets.reveal\n${hash}\n1792092886339\n${nonce}`)), null, "a presence proof for any other tool is not signed blind");
  assert.equal(summaryOf(enc.encode(`vyre-presence-v1\npresence.person.start\n${hash}\nsoon\n${nonce}`)), null);
});

test("anything else has no words, so the Face ID key does not sign it", () => {
  for (const bad of [enc.encode("Unlock Drive"), new Uint8Array(0), Uint8Array.from([0xff, 0xfe, 0x00]), enc.encode(JSON.stringify({ decision: "x", payload_hash: "y", nonce: "z" }))]) assert.equal(summaryOf(bad), null);
  assert.equal(UNREADABLE, "Vyre cannot tell what this would sign, so it did not.");
});

test("a yes-moment's words come from its op and fields: the act, then up to six fields, no field adding a line", () => {
  assert.equal(proofSummary("vault_reveal", { name: "Northwind API key", space: "harlow" }), "Approve: vault reveal\nname: Northwind API key\nspace: harlow");
  const many = proofSummary("x", Object.fromEntries("abcdefgh".split("").map(k => [k, k === "a" ? "line\nbreak" : k === "b" ? 3 : k === "c" ? true : { n: 1 }])));
  assert.deepEqual(many.split("\n"), ["Approve: x", "a: linebreak", "b: 3", "c: yes", "d: ...", "e: ...", "f: ..."]);
});

test("every Face ID signature in the phone's signer goes through these words, and no caller's caption reaches the prompt", () => {
  const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /if \(alias === HUMAN\) return native\.sign\(HUMAN, message, \{ prompt: readable\(/);
  assert.match(src, /const said = readable\(message\);\n  return lowS\(p1363FromDer\(fromB64url\(await native\.sign\(HUMAN, new TextDecoder\(\)\.decode\(message\), \{ prompt: said \}\)\)\)\);/);
  assert.doesNotMatch(src, /card\.prompt|cards\[0\]\.prompt/, "a card's caption is never the prompt");
  const humanSigns = src.match(/native\.(sign|signMany)\(HUMAN/g) || [];
  assert.equal(humanSigns.length, 4, "sign, enclaveSign, signPresence, signPresenceMany: each is listed above");
});

test("no invisible character reaches the prompt: a bidi override, a zero width, an isolate or a line separator in a label, a field or an op is dropped", () => {
  const sneaky = "Ana\u202E\u200Benohp\u2066x\u2069\u2028y";
  assert.equal(clean(sneaky), "Anaenohpxy");
  assert.equal(summaryOf(chain(JSON.stringify({ type: "add", entry: { kind: "device", label: sneaky } }))), "Add a device: Anaenohpxy");
  const p = proofSummary("vault\u202Ereveal", { name: "Stripe\u200B key", ["no\u2067te"]: "a\u2029b" });
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(p.replace(/\n/g, "")), JSON.stringify(p));
  assert.deepEqual(p.split("\n"), ["Approve: vaultreveal", "name: Stripe key", "note: ab"]);
});

test("the one prompt for a held group cleans each op, as one card's prompt does", () => {
  const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(src, /cards\.slice\(0, 4\)\.map\(\(c\) => clean\(String\(c\.op\)\.replace\(\/_\/g, " "\), 60\)\)/);
});
