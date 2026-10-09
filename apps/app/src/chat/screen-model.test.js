// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWord, dots, signinWords } from "./screen-model.js";
import { normalizeBlock } from "./blocks.js";

test("a run says one word, keeps seven steps, and a sign-in says what it asks and what stays private", () => {
  assert.equal(runWord("stuck"), "Needs you");
  assert.equal(dots(Array.from({ length: 10 }, (_, i) => ({ line: `step ${i}`, state: "done" }))).length, 7);
  assert.equal(dots([{ line: "x", state: "nonsense" }])[0].state, "done");
  assert.match(signinWords({ site: "GoHighLevel", state: "waiting" }).detail, /cannot see the page/);
  assert.equal(signinWords({ site: "GoHighLevel", state: "done" }).title, "Signed in to GoHighLevel");
});

test("operator and sign-in blocks keep words and ids; a malformed one degrades to text", () => {
  const o = normalizeBlock({ block: "operator", run: "0a1b2c3d4e5f", computer: "kit", title: "Kit's computer", state: "working", line: "Reading the list", steps: [{ line: "Opening the site", state: "done" }, { line: "", state: "done" }] });
  assert.equal(o.block, "operator");
  assert.deepEqual(o.block === "operator" && o.steps, [{ line: "Opening the site", state: "done" }]);
  assert.equal(normalizeBlock({ block: "operator", run: "x", computer: "kit" }).block, "text");
  const s = normalizeBlock({ block: "signin", id: "0a1b2c3d4e5f", computer: "kit", site: "GoHighLevel", state: "waiting", password: "never" });
  assert.deepEqual(s, { block: "signin", id: "0a1b2c3d4e5f", computer: "kit", site: "GoHighLevel", why: "", state: "waiting" });
  assert.equal(normalizeBlock({ block: "signin", id: "0a1b2c3d4e5f", computer: "kit" }).block, "text");
});

test("the vault's logins for a site: bound to that host or its parent, exact first, never another kind", async () => {
  const { loginsFor, stillWord } = await import("./screen-model.js");
  const items = [
    { name: "GHL agency", kind: "login", hosts: ["https://app.gohighlevel.test"] },
    { name: "GHL parent", kind: "login", hosts: ["gohighlevel.test"] },
    { name: "Other site", kind: "login", hosts: ["https://example.test"] },
    { name: "An API key", kind: "api-key", hosts: ["https://app.gohighlevel.test"] },
    { name: "No host", kind: "login" },
  ];
  assert.deepEqual(loginsFor(items, "app.gohighlevel.test"), [{ name: "GHL agency", origin: "https://app.gohighlevel.test", exact: true }, { name: "GHL parent", origin: "https://gohighlevel.test", exact: false }]);
  assert.deepEqual(loginsFor(items, "example.test").map((x) => x.name), ["Other site"]);
  assert.deepEqual(loginsFor([], "x.test"), []);
  assert.equal(stillWord("mac"), "The picture stays on your Mac.");
});
