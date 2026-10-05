// @ts-check
// One adapter per AI provider (team/0.3/DESIGN-provider-adapter.md): a provider's formats, flags, files, hooks and auth belong in core/sessions/drivers/<provider>, so a provider update breaks one
// folder. This scans the product code OUTSIDE the drivers for those tokens and compares each file's count with a frozen list of today's: a file may lose hits and never gain one, and a new file
// may not appear. The list only shrinks, as test/no-internal-words.test.js does. When a provider's part moves into its adapter, lower the list in the same commit:
//   PROVIDER_ALLOW_WRITE=1 node --test test/provider-adapters.test.js
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOW = path.join(ROOT, "test", "provider-adapters.allow.json");
const ROOTS = ["core", "lib", "harness", "kernel", "local", "relay"];

/** The provider-format tokens: what only an adapter may know. */
const TOKENS = {
  "claude-sdk-shape": /stream_event|content_block|tool_use_id|tool_use\b|tool_result|parent_tool_use_id|updatedPermissions|permission_suggestions/,
  "claude-cli-flags": /--resume|--session-id|--fork-session|--permission-mode|--include-partial|--output-format|stream-json|--setting-sources|--append-system-prompt|--plugin-dir/,
  "claude-env-auth": /CLAUDE_CODE_|ANTHROPIC_|VYRE_CLAUDE_BIN|claudeBin|CLAUDE_CONFIG_DIR/,
  "claude-files": /\.claude\/projects|\.claude-plugin|\.claude\/settings|claudeHome|\.claude\b/,
  "claude-hooks": /hookSpecificOutput|hook_event_name|PreToolUse|PostToolUse|SessionStart|UserPromptSubmit/,
  "transcript-format": /\.jsonl|transcriptFolders|findSession|sessionInfo/,
  "codex-grok": /\.codex\b|agent_message_chunk|session\/update|\bgrok-|xai/,
};

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "drivers" || e.name === "testing" || e.name === "docs") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name) && !/\.test\.(js|mjs)$/.test(e.name)) out.push(p);
  }
}

/** @returns {Record<string, number>} hits per file (a line counts once per token kind) */
function scan() {
  /** @type {string[]} */ const files = [];
  for (const r of ROOTS) if (fs.existsSync(path.join(ROOT, r))) walk(path.join(ROOT, r), files);
  /** @type {Record<string, number>} */ const counts = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    let n = 0;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      for (const re of Object.values(TOKENS)) if (re.test(line)) n++;
    }
    if (n) counts[rel] = n;
  }
  return counts;
}

test("provider formats stay behind the adapters: no file outside core/sessions/drivers gains a provider token, and the list only shrinks", () => {
  const now = scan();
  if (process.env.PROVIDER_ALLOW_WRITE === "1") { fs.writeFileSync(ALLOW, JSON.stringify(Object.fromEntries(Object.entries(now).sort()), null, 1) + "\n"); return; }
  /** @type {Record<string, number>} */ const allowed = JSON.parse(fs.readFileSync(ALLOW, "utf8"));
  const worse = Object.entries(now).filter(([f, n]) => n > (allowed[f] ?? 0)).map(([f, n]) => `${f}: ${n} (allowed ${allowed[f] ?? 0})`);
  assert.deepEqual(worse, [], "a provider's format, flag, file, hook or auth token appeared outside its adapter: put it behind core/sessions/drivers/<provider>, or (if it cannot) say why to the chat team");
  const stale = Object.entries(allowed).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `${f}: ${now[f] ?? 0} (list says ${n})`);
  assert.deepEqual(stale, [], "the list is out of date: a part moved into its adapter. Lower it with PROVIDER_ALLOW_WRITE=1 node --test test/provider-adapters.test.js");
});
