// One Space per server (rc.2): the screen that makes a team on the paired server names the server's OWN Space (spaces.name-here); it does not host a second one (spaces.host-here, kept only for installs that already have one and for the CLI path).
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (/** @type {string} */ f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");

test("makeServerSpace (what the install screen calls) names the server's own Space and never hosts another", () => {
  const src = read("./install.ts");
  const body = src.slice(src.indexOf("export async function makeServerSpace"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 3);
  assert.match(fn, /nameServerOwnSpace\(/, "it names the server's own Space");
  assert.doesNotMatch(fn, /makeSpaceOnPairedServer|hostOnPairedServer|host-here/, "it does not host a second Space");
});

test("nameServerOwnSpace asks the server to name its own Space and publishes the record for that id", () => {
  const src = read("./claim-space.ts");
  const fn = src.slice(src.indexOf("export async function nameServerOwnSpace"));
  assert.match(fn, /"spaces\.name-here", \{ name \}/);
  assert.match(fn, /"spaces\.name-here", \{ name: claimed\.label, done: true \}/, "the name is kept only after the directory has the record");
  assert.doesNotMatch(fn, /retire/, "nothing is hosted, so nothing is retired on a refusal");
});
