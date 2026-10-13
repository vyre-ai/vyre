// @ts-check
// The prompt people give their AI agent: docs/for-agents/PROMPT.md holds exactly the text the site serves (scripts/site/agent-prompt.mjs),
// every file it links exists in the repo, it never leads with gaps, and the /map/ page carries the form and the same prompt.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT, PROMPT_FILES } from "../scripts/site/agent-prompt.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("PROMPT.md holds exactly the prompt the site serves", () => {
  const m = /```text\n([\s\S]*?)\n```/.exec(read("docs/for-agents/PROMPT.md"));
  assert.ok(m, "a text block");
  assert.equal(m[1], PROMPT);
});

test("every raw GitHub file the prompt links exists", () => {
  for (const f of PROMPT_FILES) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  for (const f of PROMPT_FILES) assert.ok(PROMPT.includes(`raw.githubusercontent.com/vyre-ai/vyre/main/${f}`), `${f} is in the prompt`);
});

test("the prompt asks for the interview and the map, treats gaps as extensions, offers MCP setup, and keeps the house rules", () => {
  for (const w of ["INTERVIEW ME", "MAP MY BUSINESS", "module contract", "Integration", "vyre mcp install", "Your AI keys", "Engineer", "Gate", "Next"]) assert.ok(PROMPT.includes(w), w);
  assert.ok(!/known.gaps/i.test(PROMPT));
  assert.ok(!/[—§]/.test(PROMPT), "no em dash or section sign");
});

test("the entry points do not link known-gaps", () => {
  for (const f of ["README.md", "ARCHITECTURE.md", "docs/index.md", "docs/for-agents/MAP-YOUR-BUSINESS.md", "docs/for-agents/PROMPT.md", "site/llms.txt", "site/llms-full.txt", "site/agents.md"]) assert.ok(!/known-gaps/.test(read(f)), `${f} does not link known-gaps`);
  assert.ok(read("README.md").includes("docs/for-agents/PROMPT.md"));
  assert.ok(read("docs/for-agents/MAP-YOUR-BUSINESS.md").includes("PROMPT.md"));
});

test("the home page and /map/ carry the prompt, a Copy button and the form", () => {
  const home = read("site/index.html"), map = read("site/map/index.html");
  assert.match(home, /Give this to your AI agent/);
  assert.match(home, /data-copy-from="home-prompt"/);
  assert.match(map, /id="mform"/);
  assert.match(map, /data-copy-from="prompt-out"/);
  assert.match(map, /id="map-data"/);
  assert.ok(read("site/llms-full.txt").includes("INTERVIEW ME"));
  assert.ok(read("site/llms.txt").includes("/map/"));
});
