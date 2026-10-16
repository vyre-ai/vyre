// @ts-check
// The prompt people give their AI agent is short and points at https://vyre.run/agenthome.md. The instructions live in
// docs/for-agents/START-HERE.md, and gen-site serves it as /agenthome.md (raw) and /agenthome/ (readable HTML, real text, no script).
// The /map/ page builds the same prompt with the person's details on one line.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT } from "../scripts/site/agent-prompt.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const START = read("docs/for-agents/START-HERE.md");

test("PROMPT.md holds exactly the short prompt the site serves, and the prompt is short", () => {
  const m = /```text\n([\s\S]*?)\n```/.exec(read("docs/for-agents/PROMPT.md"));
  assert.ok(m, "a text block");
  assert.equal(m[1], PROMPT);
  assert.ok(PROMPT.includes("https://vyre.run/agenthome.md"));
  assert.ok(PROMPT.length < 320, "two or three lines");
  assert.ok(!/[\u2014\u00a7]/.test(PROMPT));
});

test("every file START-HERE links exists in the repo, on the hosted docs or as a raw GitHub file", () => {
  const raw = [...START.matchAll(/raw\.githubusercontent\.com\/vyre-ai\/vyre\/main\/([A-Za-z0-9_./-]+\.(?:md|json))/g)].map((m) => m[1]);
  for (const f of raw) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  const hosted = [...START.matchAll(/https:\/\/vyre\.run\/docs\/([A-Za-z0-9_./-]+\.md)/g)].map((m) => m[1]);
  assert.ok(hosted.length >= 8, "a reading list");
  for (const h of hosted) {
    const src = h.startsWith("project/") ? h.slice(8) : h.startsWith("roadmap/") ? h : path.join("docs", h);
    assert.ok(fs.existsSync(path.join(ROOT, src)), `${h} exists as ${src}`);
  }
  for (const f of ["records", "flows", "agents", "vault", "gate", "mcp-and-engineer"]) assert.ok(START.includes(`${f}.md`), f);
  assert.ok(/only from vyre\.run pages/.test(START), "instructions only from vyre.run");
});

test("START-HERE carries the reading list, the questions, the mapping, Get started, Next and Stay in the loop, and no gaps link", () => {
  for (const h of ["## What Vyre is", "## How to operate", "## A map of everything", "## 2. Ask", "## 3. Map", "## 4. Get started", "## Next", "## Stay in the loop"]) assert.ok(START.includes(h), h);
  for (const w of ["DigitalOcean", "Hetzner", "8 GB", "2 GB", "cloud-init", "vyre mcp connect", "tools_find", "Engineer", "https://vyre.run/setup", "https://vyre.run/updates/", "wink.install.issue", "wink.install.status", "wink.install.complete", "Gate"]) assert.ok(START.includes(w), w);
  assert.ok(!/known-gaps/i.test(START));
  assert.ok(!/[\u2014\u00a7]/.test(START), "no em dash or section sign");
});

test("the site serves START-HERE as /agenthome.md and as real HTML text at /agenthome/", () => {
  assert.equal(read("site/agenthome.md"), START);
  const html = read("site/agenthome/index.html");
  assert.match(html, /<h1 id="[^"]*">Start here: Vyre, for AI agents<\/h1>/);
  assert.match(html, /Step 3\. Create the server/);
  assert.match(html, /href="https:\/\/vyre\.run\/updates\/"/);
  assert.match(html, /<h2 id="4-get-started">4\. Get started<\/h2>/);
  for (const f of ["site/llms.txt", "site/agents.md", "site/.well-known/agent.json"]) assert.ok(read(f).includes("agenthome"), `${f} names agenthome`);
});

test("the entry points do not link known-gaps and point at the prompt and START-HERE", () => {
  for (const f of ["README.md", "ARCHITECTURE.md", "docs/index.md", "docs/for-agents/MAP-YOUR-BUSINESS.md", "docs/for-agents/PROMPT.md", "site/llms.txt", "site/llms-full.txt", "site/agents.md"]) assert.ok(!/known-gaps/.test(read(f)), `${f} does not link known-gaps`);
  assert.ok(read("README.md").includes("docs/for-agents/PROMPT.md"));
  assert.ok(read("README.md").includes("START-HERE.md"));
  assert.ok(read("docs/for-agents/MAP-YOUR-BUSINESS.md").includes("PROMPT.md"));
});

test("the home page and /map/ carry the short prompt, a Copy button and the form", () => {
  const home = read("site/index.html"), map = read("site/map/index.html");
  assert.match(home, /Give this to your AI agent/);
  assert.match(home, /data-copy-from="home-prompt"/);
  assert.ok(home.includes("Read https://vyre.run/agenthome.md and follow it"));
  assert.match(map, /id="mform"/);
  assert.match(map, /data-copy-from="prompt-out"/);
  assert.match(map, /id="map-data"/);
  assert.ok(read("site/llms-full.txt").includes("agenthome.md"));
});
