// @ts-check
// claudeHome: the person's real Claude Code folder only for their own ~/.vyre.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { claudeHome, realHome } from "./dialogs.js";
import { load } from "./index.js";
import { tempHome } from "../../test/helpers.js";

test("claudeHome: ~/.claude only for the real ~/.vyre; any other home keeps its own", () => {
  const real = realHome();
  assert.equal(claudeHome(real, {}), path.join(os.homedir(), ".claude"));
  assert.equal(claudeHome(real, { CLAUDE_CONFIG_DIR: "/opt/cc" }), "/opt/cc", "the person's own CLAUDE_CONFIG_DIR");
  const temp = path.join(os.tmpdir(), "vy-dev-home");
  assert.equal(claudeHome(temp, {}), path.join(temp, "claude"), "a dev or temp home");
  assert.equal(claudeHome(temp, { CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude") }), path.join(temp, "claude"),
    "an inherited CLAUDE_CONFIG_DIR is not an opt-in");
  assert.equal(claudeHome(temp, { VYRE_CLAUDE_HOME: "/srv/cc" }), "/srv/cc", "named outright");
});

test("claudeHome: a temp home's default transcripts are inside it", t => {
  const root = tempHome(t);
  const c = load(root);
  const inside = path.join(root, "claude");
  assert.deepEqual(c.transcripts, [path.join(inside, "projects"), path.join(inside, "projects-archive")]);
  assert.ok(!c.transcripts.some(f => f.startsWith(path.join(os.homedir(), ".claude"))));
});
