import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { profileHandle, profileLine, profileRole } from "./profile-model.js";

test("the role is the one named for this Space", () => {
  assert.equal(profileRole("Owner of Mine", "Mine"), "Owner");
  assert.equal(profileRole("Owner of Mine, Admin of Juniper Studio", "Juniper Studio"), "Admin");
  assert.equal(profileRole("Admin of Harbor", "Harbor"), "Admin");
  assert.equal(profileRole("Owner of Mine, Admin of Juniper Studio", "Harbor"), "Member");
  assert.equal(profileRole("Admin of A+B", "A+B"), "Admin");
});

test("a line that is already a role word is that role, and anything else is Member", () => {
  assert.equal(profileRole("Owner", "Mine"), "Owner");
  assert.equal(profileRole("Admin", "Juniper Studio"), "Admin");
  assert.equal(profileRole("Member", "Mine"), "Member");
  assert.equal(profileRole("Manager", "Mine"), "Manager");
  assert.equal(profileRole("Guest", "Mine"), "Guest");
  assert.equal(profileRole("Design studio", "Juniper Studio"), "Member");
  assert.equal(profileRole("Personal space", "Mine"), "Member");
  assert.equal(profileRole("", "Mine"), "Member");
});

test("the username is shown with @ and the domain dropped", () => {
  assert.equal(profileHandle("Noah Hale", "noah.vyre.run"), "@noah");
  assert.equal(profileHandle("Alex Rivera", "alex.vyre.run"), "@alex");
  assert.equal(profileHandle("Noah", "noah"), "@noah");
  assert.equal(profileHandle("Noah Hale", ""), "");
  assert.equal(profileHandle("Noah Hale", "Setting up"), "");
});

test("the line names the Space, and falls back when the Space has no name yet", () => {
  assert.equal(profileLine("Mine"), "How you show up in Mine. Each Space has its own profile.");
  assert.equal(profileLine("Juniper Studio"), "How you show up in Juniper Studio. Each Space has its own profile.");
  assert.equal(profileLine(""), "How you show up in this Space. Each Space has its own profile.");
});
