import test from "node:test";
import assert from "node:assert/strict";
import { backOf, homeLine, nameNote, nameStatus, pickNumber, serverLines, slug, startStep, SERVER_NUMBER } from "./flow.js";

test("a slug is what goes before .vyre.run", () => {
  assert.equal(slug("Harlow Legal"), "harlow-legal");
  assert.equal(slug("  Northwind Bakery! "), "northwind-bakery");
  assert.equal(slug(""), "");
});

test("a name is empty, short, taken or ok", () => {
  assert.equal(nameStatus("").state, "empty");
  assert.equal(nameStatus("al").state, "short");
  assert.equal(nameStatus("Alex").state, "taken");
  assert.equal(nameStatus("jordan").state, "ok");
  assert.equal(nameStatus("jordan").address, "jordan.vyre.run");
});

test("a space cannot take its owner's name", () => {
  assert.equal(nameStatus("Jane", ["jane"]).state, "taken");
});

test("the note says what happened", () => {
  assert.equal(nameNote(nameStatus("harlow"), true), "harlow.vyre.run is taken. People and spaces share names.");
  assert.equal(nameNote(nameStatus("harlow"), false), "harlow.vyre.run is taken.");
  assert.equal(nameNote(nameStatus("ab"), false), "Use at least three letters.");
  assert.equal(nameNote(nameStatus("northwind"), true), "northwind.vyre.run is yours to take.");
  assert.equal(nameNote(nameStatus(""), true), "");
});

test("back from a server step goes to the server's first screen", () => {
  assert.equal(backOf("srv2", { vps: true }), "vps");
  assert.equal(backOf("srv2", { vps: false }), "cmd");
  assert.equal(backOf("where"), "create");
  assert.equal(backOf("recovery"), null);
});

test("each route starts at its step", () => {
  assert.equal(startStep("create"), "create");
  assert.equal(startStep("join"), "join");
  assert.equal(startStep(undefined), "name");
});

test("the right number finishes pairing and a wrong one starts over", () => {
  assert.deepEqual(pickNumber(SERVER_NUMBER), { ok: true, step: "done" });
  assert.deepEqual(pickNumber("12"), { ok: false, step: "srv1" });
});

test("the server prints the code prompt only on the second screen", () => {
  assert.equal(serverLines(false, "Northwind Bakery", false).length, 3);
  assert.ok(serverLines(false, "Northwind Bakery", true).some((l) => l.startsWith("Enter the code from your phone or computer:")));
  assert.equal(serverLines(true, "X", false)[0], "Created northwind on DigitalOcean");
});

test("a space made on this computer says it sleeps", () => {
  assert.match(homeLine("here"), /Unreachable while it sleeps/);
});
