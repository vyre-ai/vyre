import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NOTES, noteFor, useRefusal, YOURS } from "./own-home.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const walk = (/** @type {string} */ d, /** @type {string[]} */ out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === "node_modules") continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };

test("the ten screens that show her own home each say so, plainly, and name what the team's side holds", () => {
  assert.deepEqual(Object.keys(NOTES).sort(), ["assistants", "connections", "devices", "drive", "find", "memory", "planner", "providers", "publish", "vault"]);
  for (const [k, n] of Object.entries(NOTES)) {
    assert.equal(n.body, YOURS, `${k}: it says the screen is on her own computer, not the team's`);
    assert.ok(n.team.length > 20, `${k}: the team's side is said`);
    assert.ok(!/\bfl_|vault:\/\//.test(n.team), `${k}: no id or address in the words`);
  }
  assert.equal(noteFor("nope"), null);
});

test("every one of them draws the notice: its screen file renders OwnHomeNotice with its key", () => {
  const files = walk(path.join(APP, "screens")).filter((f) => /\.tsx$/.test(f)).map((f) => fs.readFileSync(f, "utf8"));
  for (const k of Object.keys(NOTES)) assert.ok(files.some((s) => s.includes(`<OwnHomeNotice screen="${k}" />`)), `${k} has its notice`);
});

test("trying to use a Space assistant or a teammate answers with the gate's own words and starts nothing", () => {
  assert.match(useRefusal({ name: "research" }, false), /research has no AI sign-in picked for it, and the owner's is not used for your request\. Ask the owner to pick one for it\. Nothing was started\./);
  assert.match(useRefusal({ name: "research", kind: "teammate" }, false), /not on this project's team\. Ask the project's owner to add you, then ask again\. Nothing was queued\./);
  assert.match(useRefusal({ name: "research", kind: "teammate" }, true), /cannot be used for a teammate's request yet/);
});
