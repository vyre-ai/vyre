import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { groupsOf, groupOf, breachBanner, GROUP_LABEL, sectionOf, SECTIONS } from "./vault-groups.js";

test("vault groups: keys go to AI and apps, sign-ins to Logins, and every other kind to Notes and other", () => {
  const items = [
    { id: "a", kind: "Key" }, { id: "b", kind: "Login" }, { id: "c", kind: "Card" }, { id: "d", kind: "Note" }, { id: "e", kind: "Login" },
  ];
  const g = groupsOf(items);
  assert.deepEqual(g["ai-and-apps"].map((i) => i.id), ["a"]);
  assert.deepEqual(g.logins.map((i) => i.id), ["b", "e"]);
  assert.deepEqual(g["notes-and-other"].map((i) => i.id), ["c", "d"]);
  assert.equal(groupOf({ kind: "Wi-Fi" }), "notes-and-other", "a kind nobody named still has a group");
});

test("vault groups: the labels are the plain words of the spec", () => {
  assert.deepEqual([GROUP_LABEL["ai-and-apps"], GROUP_LABEL.logins, GROUP_LABEL["notes-and-other"]], ["AI and apps", "Logins", "Notes and other"]);
});

test("vault breach banner: only when one of the person's own items is breached, with the count in words", () => {
  assert.equal(breachBanner([{ breached: false }, { kind: "Login" }]), null, "nothing breached: no banner");
  assert.equal(breachBanner([{ breached: true }]), "1 password showed up in a known breach. Change it now. It takes about a minute each.");
  assert.match(breachBanner([{ breached: true }, { breached: true }]), /^2 passwords showed up/);
  assert.equal(breachBanner([{ breached: true, mine: false }]), null, "a breached item that is someone else's is not the person's to fix here");
});

test("vault sections: a card, a note or an identity is Notes and other; a login is Logins; the rest is AI and apps", () => {
  assert.equal(sectionOf("Logins", "card"), "Notes and other", "a card is not a login, whatever its group says");
  assert.equal(sectionOf("Secure notes", "note"), "Notes and other");
  assert.equal(sectionOf("Logins", "login"), "Logins");
  assert.equal(sectionOf("Logins"), "Logins");
  assert.equal(sectionOf("AI models", "key"), "AI and apps");
  assert.equal(sectionOf("Apps you connected", "connection"), "AI and apps");
  assert.equal(sectionOf("SSH keys", "ssh-key"), "AI and apps");
  assert.deepEqual(SECTIONS, ["AI and apps", "Logins", "Notes and other"]);
});
