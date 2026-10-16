// @ts-check
// Every skills library entry point names skills.browse (or skills.serve browse) as the shared read path.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMBER_TOOLS } from "../work/member-tools.js";
import { CALLS } from "../../kernel/remote/wire.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("registry-derived: member door and MCP core expose browse; list routes through serve browse", () => {
  assert.ok(CALLS.skills.includes("browse"));
  assert.equal(MEMBER_TOOLS["skills.browse"].call, "browse");
  assert.equal(MEMBER_TOOLS["skills.list"].tool, "skills.serve");
  const idx = fs.readFileSync(path.join(ROOT, "core/skills/index.js"), "utf8");
  assert.match(idx, /browsePack/);
  assert.match(idx, /skills\.browse[\s\S]*browsePack/);
  assert.match(idx, /skills\.list[\s\S]*browsePack/);
  const mcp = fs.readFileSync(path.join(ROOT, "harness/mcp/core-tools.js"), "utf8");
  assert.match(mcp, /skills_browse/);
  const app = fs.readFileSync(path.join(ROOT, "apps/app/screens/skills/skills-source.ts"), "utf8");
  assert.match(app, /skills\.browse/);
  const cli = fs.readFileSync(path.join(ROOT, "core/cli/commands/skills.js"), "utf8");
  assert.match(cli, /skills\.browse/);
  const chat = fs.readFileSync(path.join(ROOT, "apps/app/src/chat/core/commands.js"), "utf8");
  assert.match(chat, /name: "skills"/);
  const mcpMem = fs.readFileSync(path.join(ROOT, "harness/mcp/memory-tools.js"), "utf8");
  assert.match(mcpMem, /skills_list[\s\S]*skills\.browse/);
  assert.match(mcpMem, /skills_browse[\s\S]*skills\.browse/);
  assert.match(mcpMem, /skills_decline[\s\S]*skills\.decline/);
  const memberOps = fs.readFileSync(path.join(ROOT, "core/skills/member-ops.js"), "utf8");
  assert.match(memberOps, /ops\.browse/);
  assert.match(memberOps, /o\.browse/);
});
