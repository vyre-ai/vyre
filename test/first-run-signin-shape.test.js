// @ts-check
// The sign-in shapes the first-run screens share (lib/first-run-shape.js): a space's address as a person types it, the first screen, and the phase of each sign-in screen.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNIN_COPY, entryScreen, phaseOf, spaceAddressOf } from "../lib/first-run-shape.js";

test("a space address is a name under vyre.run, typed with or without https, and nothing else", () => {
  for (const ok of ["juniper.vyre.run", "https://juniper.vyre.run", "https://Juniper.vyre.run/", "  juniper.vyre.run  "]) assert.deepEqual(spaceAddressOf(ok), { space: "juniper", address: "https://juniper.vyre.run" }, ok);
  for (const no of ["", "vyre.run", "juniper.example.com", "juniper.vyre.run.evil.example", "http://juniper.vyre.run.evil.example", "a.b.vyre.run", "-x.vyre.run", "https://user@juniper.vyre.run", "juniper.vyre.run/path"]) assert.equal(spaceAddressOf(no), null, no);
});

test("a person with no path opens on the choice of creating or signing in; an explicit path keeps its own first screen", () => {
  assert.equal(entryScreen(undefined), "id.choice");
  assert.equal(entryScreen("signin"), "id.signin");
  assert.equal(entryScreen("create"), "id.create");
  assert.equal(entryScreen("computer"), "computer.add");
  assert.equal(SIGNIN_COPY.choiceTitle, "Get started");
});

test("every sign-in screen is in the Identity phase", () => {
  for (const s of ["id.choice", "id.signin", "id.signin.spaces", "id.create", "id.recovery", "id.ai"]) assert.equal(phaseOf(s), 0, s);
  assert.equal(phaseOf("space.choice"), 1);
  assert.equal(phaseOf("ready"), 2);
});
