// @ts-check
// An id the app made (spc_..., per_..., tpl_...) is never for a person to read: a screen says the name. This reads every screen's source for the two ways an id gets onto the page as text: a literal id-shaped string
// in a text, title, sub, label or placeholder, and a Space's id (.space, .spaceId, .space_id) put straight into one. The names come through src/state/space-name.js and the other naming functions.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** @param {string} dir @param {string[]} [out] */
function tsx(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith("dist") || e.name === ".expo") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tsx(p, out);
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

const LITERAL_ID = /["'`](?:spc|per|tpl)_[A-Za-z0-9]{3,}/;
const TEXT_SLOT = /<Text|\btitle=|\bsub=|\blabel=|\bplaceholder=|>[^<{]*(?:spc|per|tpl)_/;
const SPACE_ID_AS_TEXT = /(?:<Text[^>]*>\s*\{|\b(?:title|sub|label|placeholder)=\{)[^}]*\.(?:space|spaceId|space_id)\}/;

test("no screen puts an id the app made, or a Space's id, on the page as text", () => {
  /** @type {string[]} */ const bad = [];
  for (const root of ["screens", "src", "ui"]) {
    for (const file of tsx(path.join(APP, root))) {
      const rel = path.relative(APP, file);
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if ((LITERAL_ID.test(line) && TEXT_SLOT.test(line)) || SPACE_ID_AS_TEXT.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
  }
  assert.deepEqual(bad, [], "show the name (spaceName, the person's name, the template's title), never the id");
});

test("the check itself can fail: it sees a literal id in a text and a Space's id in one", () => {
  assert.ok(LITERAL_ID.test('<Text>{"spc_zqvwc5w7zo5v"}</Text>') && TEXT_SLOT.test('<Text>{"spc_zqvwc5w7zo5v"}</Text>'));
  assert.ok(SPACE_ID_AS_TEXT.test("<Text>{row.space}</Text>"));
  assert.ok(SPACE_ID_AS_TEXT.test("<Row title={r.spaceId} />"));
  assert.ok(!SPACE_ID_AS_TEXT.test("<Row title={spaceName(r)} />"));
});
