import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { moduleHref, SPACE_MODULE, visibleTo, keepHidden } from "../../../../lib/sidebar/model.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..", "..", "..");

test("a screen of the Space's own opens at the app's route: /u/module/<module>/<screen>", () => {
  const route = path.join(APP, "app", "u", "module", "[module]", "[view].tsx");
  assert.ok(fs.existsSync(route), "the route the sidebar's href opens");
  assert.equal(moduleHref(SPACE_MODULE, "overview"), "/u/module/space/overview", "the address the sidebar gives");
  const src = fs.readFileSync(route, "utf8");
  assert.match(src, /useLocalSearchParams/, "the route reads the module and the view from the path");
  assert.match(src, /ModuleScreenHost/, "and hands them to the host that draws the screen");
});

test("the app draws a screen of the Space's own itself: the catalogue marks it as a view", () => {
  const src = fs.readFileSync(path.join(HERE, "ModuleScreenHost.tsx"), "utf8");
  assert.match(src, /\.view\b/, "the catalogue's view flag is what says the app draws it");
  assert.match(src, /<ViewHost module=\{module\} view=\{screen\}/, "and it is drawn by the view host, at the app's own route");
});

test("what a person may not see is not offered in a panel nor listed in the editor: one rule, and saving keeps the rest", () => {
  const list = [
    { kind: "place", id: "now" },
    { kind: "place", id: "vault", roles: ["admin"] },
  ];
  assert.deepEqual(visibleTo(list, { role: "member" }).map((e) => e.id), ["now"], "a member is offered the entries for everyone");
  assert.deepEqual(visibleTo(list, { role: "admin" }).map((e) => e.id), ["now", "vault"], "an admin is offered the admin's entry");
  assert.deepEqual(keepHidden(list, [{ kind: "place", id: "now" }]).map((e) => e.id), ["now", "vault"], "saving keeps the entry the person may not see");
});
