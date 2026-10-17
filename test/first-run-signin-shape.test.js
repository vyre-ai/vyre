// @ts-check
// The sign-in shapes the first-run screens share (lib/first-run-shape.js): a space's address as a person types it, the first screen, and the phase of each sign-in screen.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SIGNIN_COPY, entryScreen, phaseOf, spaceAddressOf, spaceNameSuggestions, SPACE_NAME_SAY, usernameOf } from "../lib/first-run-shape.js";

test("a space address is a name under vyre.run, typed with or without https, and nothing else", () => {
  for (const ok of ["juniper.vyre.run", "https://juniper.vyre.run", "https://Juniper.vyre.run/", "  juniper.vyre.run  "]) assert.deepEqual(spaceAddressOf(ok), { space: "juniper", address: "https://juniper.vyre.run" }, ok);
  for (const no of ["", "vyre.run", "juniper.example.com", "juniper.vyre.run.evil.example", "http://juniper.vyre.run.evil.example", "a.b.vyre.run", "-x.vyre.run", "https://user@juniper.vyre.run", "juniper.vyre.run/path"]) assert.equal(spaceAddressOf(no), null, no);
});

test("a person with no path opens on the choice of creating or signing in; an explicit path keeps its own first screen", () => {
  assert.equal(entryScreen(undefined), "id.choice");
  assert.equal(entryScreen("signin"), "id.signin");
  assert.equal(entryScreen("create"), "id.create");
  assert.equal(SIGNIN_COPY.choiceTitle, "Get started");
});

test("every sign-in screen is in the Identity phase", () => {
  for (const s of ["id.choice", "id.signin", "id.signin.spaces", "id.create", "id.recovery", "id.ai"]) assert.equal(phaseOf(s), 0, s);
  assert.equal(phaseOf("space.choice"), 1);
  assert.equal(phaseOf("ready"), 2);
});

test("space name suggestions are valid names built from the username, differ from the username, and vary", () => {
  let n = 0;
  const random = () => { n += 1; return (n * 0.137) % 1; };
  const list = spaceNameSuggestions("alex", 4, random);
  assert.equal(list.length, 4);
  assert.equal(new Set(list).size, 4);
  for (const s of list) { assert.ok(usernameOf(s), s); assert.notEqual(s, "alex"); assert.ok(s.startsWith("alex-"), s); }
  const long = spaceNameSuggestions("abcdefghijklmnopqrst", 2, random);
  for (const s of long) assert.ok(usernameOf(s) && s.length <= 20, s);
  assert.deepEqual(spaceNameSuggestions("", 2, random), [], "no username, nothing to build on");
  assert.match(SPACE_NAME_SAY.taken("alex-k7q2"), /taken.*alex-k7q2/);
});
