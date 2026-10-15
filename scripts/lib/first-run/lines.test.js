// @ts-check
// The first-run proof reads the app's screens; these hold its readers to what the app prints.
import "../../mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installLine } from "../../../apps/app/screens/install/first-run.js";
import { codeFromInstallLine, wordsFromPage, shows } from "./lines.mjs";

test("the code is read from the install line the app itself makes, for a server and for a Mac", () => {
  const code = "K7QM4P2XJ9";
  assert.equal(codeFromInstallLine(installLine("0.6.0", { code })), code);
  assert.equal(codeFromInstallLine(installLine("0.6.0-rc.1", { code, os: "mac" })), code);
  assert.equal(codeFromInstallLine(installLine("0.6.0", {})), "", "a line with no code has none");
  assert.equal(codeFromInstallLine(""), "");
});

test("the four words are the ones under 'Words on this screen', and nothing else on the page", () => {
  const page = "Do the four words match?\nYour server shows four words too.\nWords on this screen\nriver amber stone quiet\nCheck them against the words on your server.\nThey match";
  assert.deepEqual(wordsFromPage(page), ["river", "amber", "stone", "quiet"]);
  assert.deepEqual(wordsFromPage("Do the four words match?\nWords on this screen\n"), []);
});

test("shows ignores line breaks and spacing", () => {
  assert.ok(shows("Name  your\nspace", "Name your space"));
  assert.ok(!shows("Name your space", "Vault"));
});
