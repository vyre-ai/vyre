// @ts-check
// A temp or dev home never touches ~/.claude (the person's Claude Code sessions, settings and
// transcripts). Platform found a fresh temp home reporting "107 facts about you", read from the
// real transcripts. vyred runs in a child with HOME pointed at a planted fake home, and with
// NODE_TEST_CONTEXT cleared, since a dev world is not a test; the child refuses and records any
// fs call on a .claude path under the fake home or the real one, so nothing real is ever read.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tempHome } from "./helpers.js";

const CHILD = path.join(import.meta.dirname, "fixtures", "no-claude-child.mjs");

test("temp home: vyred, recall, memory, settings and learn never open ~/.claude", { timeout: 90_000 }, t => {
  const vyreHome = tempHome(t);
  const fake = fs.mkdtempSync(path.join(path.dirname(vyreHome), "fake-home-"));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  // A home that looks lived in: a transcript about alex, settings and a CLAUDE.md.
  const proj = path.join(fake, ".claude", "projects", "-Users-alex-northwind");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "5f0c.jsonl"), JSON.stringify({ type: "user", sessionId: "5f0c", cwd: "/Users/alex/northwind", message: { role: "user", content: "my wife is called Robin" } }) + "\n");
  fs.writeFileSync(path.join(fake, ".claude", "settings.json"), JSON.stringify({ env: { CANARY: "x" } }));
  fs.writeFileSync(path.join(fake, ".claude", "CLAUDE.md"), "canary\n");
  const env = { ...process.env, HOME: fake, VYRE_HOME: vyreHome, FAKE_HOME: fake, REAL_HOME: os.homedir(),
    VYRE_NO_DIALOGS: "1", PATH: path.dirname(process.execPath) + ":/usr/bin:/bin" };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_ENV;
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, [CHILD], { env, encoding: "utf8", timeout: 80_000 });
  const line = String(r.stdout).trim().split("\n").pop() || "";
  assert.ok(line.startsWith("{"), `child did not report: ${r.status} ${String(r.stderr).slice(-600)}`);
  const { touched } = JSON.parse(line);
  assert.deepEqual(touched, [], `a temp home reached for ~/.claude:\n${touched.join("\n")}`);
});
