// @ts-check
// claudeHome: the person's real Claude Code folder only for their own ~/.vyre.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { claudeHome, claudeJson, realHome, transcriptFolders } from "./dialogs.js";
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

test("claudeJson: ~/.claude.json only for the real ~/.vyre; any other home keeps its own, beside claudeHome's folder", () => {
  const real = realHome();
  assert.equal(claudeJson(real, {}), path.join(os.homedir(), ".claude.json"));
  assert.equal(claudeJson(real, { CLAUDE_CONFIG_DIR: "/opt/cc" }), path.join("/opt/cc", ".claude.json"),
    "CLAUDE_CONFIG_DIR moves .claude.json inside it too (e2e LOW, 2026-09-28), the same folder claudeHome names");
  const temp = path.join(os.tmpdir(), "vy-dev-home");
  assert.equal(claudeJson(temp, {}), path.join(temp, "claude.json"), "a dev or temp home, never the real .claude.json");
  assert.equal(claudeJson(temp, { CLAUDE_CONFIG_DIR: path.join(os.homedir(), ".claude") }), path.join(temp, "claude.json"),
    "an inherited CLAUDE_CONFIG_DIR is not an opt-in");
  assert.equal(claudeJson(temp, { VYRE_CLAUDE_HOME: "/srv/cc" }), "/srv/.claude.json", "named outright, beside the named folder");
});

test("claudeHome: a temp home's default transcripts are inside it", t => {
  const root = tempHome(t);
  const c = load(root);
  const inside = path.join(root, "claude");
  // synced: other devices' sessions sent here with consent, inside the home too.
  assert.deepEqual(c.transcripts, [path.join(inside, "projects"), path.join(inside, "projects-archive"), path.join(root, "synced")]);
  assert.ok(!c.transcripts.some(f => f.startsWith(path.join(os.homedir(), ".claude"))));
});

test("transcriptFolders: a temp home never reads the person's Claude folder, through a symlink either way", t => {
  const root = tempHome(t);
  const base = fs.mkdtempSync(path.join(path.dirname(root), "cc-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // A stand-in for the person's own folder (CLAUDE_CONFIG_DIR), and links to it.
  const person = path.join(base, "person-claude");
  fs.mkdirSync(path.join(person, "projects"), { recursive: true });
  const link = path.join(base, "link-to-projects");
  fs.symlinkSync(path.join(person, "projects"), link);
  const env = { CLAUDE_CONFIG_DIR: person };
  const own = path.join(root, "claude", "projects");
  const elsewhere = path.join(base, "fixtures");
  assert.deepEqual(transcriptFolders([path.join(person, "projects"), link, own, elsewhere], root, env), [own, elsewhere],
    "the person's folder and a link into it are left out; the home's own and others stay");
  // The person's folder is itself a link (dotfiles); a config naming where it really points.
  const dot = path.join(base, "dotfiles-claude");
  fs.mkdirSync(path.join(dot, "projects"), { recursive: true });
  const linked = path.join(base, "linked-claude");
  fs.symlinkSync(dot, linked);
  assert.deepEqual(transcriptFolders([path.join(dot, "projects")], root, { CLAUDE_CONFIG_DIR: linked }), []);
  // Opt-ins, and the real home.
  assert.deepEqual(transcriptFolders([link], root, { ...env, VYRE_ALLOW_REAL_TRANSCRIPTS: "1" }), [link]);
  assert.deepEqual(transcriptFolders([link], realHome(), env), [link], "the person's own ~/.vyre reads them");
  assert.deepEqual(transcriptFolders([link], realHome(), { ...env, NODE_TEST_CONTEXT: "child" }), [], "never under node --test");
  assert.deepEqual(transcriptFolders([link], "", env), [], "no home named: nothing of the person's");
});
