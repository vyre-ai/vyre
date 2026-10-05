// @ts-check
// Tool calls as typed details, and what a card's header shows for each. Sample world only.

import "../../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolDetail, toolDisplay, stripGutter, splitMcp, humanize, serverLabel, TOOL_ICONS } from "./tool-detail.js";

test("stripGutter: cat -n output as the file's text, guarded against real source", () => {
  assert.deepEqual(stripGutter("     3\tconst a = 1;\n     4\t\n     5→return a;"), { content: "const a = 1;\n\nreturn a;", startLine: 3 });
  assert.equal(stripGutter("const a = 1;\n     2\tx"), undefined, "the first line must match");
  assert.equal(stripGutter("  1\ta\n  3\tb"), undefined, "numbering must run on");
  assert.equal(stripGutter("  1\ta\nplain\nplain\nplain"), undefined, "most lines must match");
  assert.equal(stripGutter(""), undefined);
  assert.equal(stripGutter(undefined), undefined);
});

test("shell: command as a string or an argv array", () => {
  assert.deepEqual(toolDetail("Bash", { command: "npm test", description: "Run tests" }, "ok"),
    { type: "shell", command: "npm test", description: "Run tests", output: "ok" });
  assert.deepEqual(toolDetail("exec_command", { cmd: ["git", " status ", ""], cwd: "/home/alex" }),
    { type: "shell", command: "git status", cwd: "/home/alex" });
  assert.deepEqual(toolDetail("Bash", { command: "ls" }, "a", { bodies: false }), { type: "shell", command: "ls" });
  assert.equal(toolDetail("Bash", {}).type, "unknown", "no command, no shell");
});

test("read: the gutter stripped, its first number as offset", () => {
  assert.deepEqual(toolDetail("Read", { file_path: "/home/alex/notes.md" }, "    10\tJuniper Studio\n    11\tNorthwind"),
    { type: "read", filePath: "/home/alex/notes.md", content: "Juniper Studio\nNorthwind", offset: 10 });
  assert.deepEqual(toolDetail("Read", { file_path: "a.md", offset: 4, limit: 2 }, "plain text", { bodies: false }),
    { type: "read", filePath: "a.md", offset: 4, limit: 2 });
});

test("write, edit, multi-edit and notebook edit", () => {
  assert.deepEqual(toolDetail("Write", { file_path: "a.txt", content: "hi" }), { type: "write", filePath: "a.txt", content: "hi" });
  assert.deepEqual(toolDetail("Edit", { file_path: "a.js", old_string: "0", new_string: "1" }),
    { type: "edit", filePath: "a.js", oldString: "0", newString: "1" });
  assert.deepEqual(toolDetail("MultiEdit", { file_path: "a.js", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }, null] }),
    { type: "edit", filePath: "a.js", oldString: "a", newString: "b", edits: [{ oldString: "a", newString: "b" }, { oldString: "c", newString: "d" }] });
  assert.deepEqual(toolDetail("MultiEdit", { file_path: "a.js", edits: [{ old_string: "a", new_string: "b" }] }),
    { type: "edit", filePath: "a.js", oldString: "a", newString: "b" }, "one edit is the top-level strings only");
  assert.deepEqual(toolDetail("NotebookEdit", { notebook_path: "n.ipynb", new_source: "x" }),
    { type: "edit", filePath: "n.ipynb", newString: "x", notebook: true });
  assert.deepEqual(toolDetail("apply_patch", { path: "p.js", patch: "@@" }, undefined, { bodies: false }), { type: "edit", filePath: "p.js" });
});

test("search: grep files and counts, glob files and truncation, web search", () => {
  assert.deepEqual(toolDetail("Grep", { pattern: "TODO", path: "src" }, "Found 2 files\nsrc/a.js\nsrc/b.js"),
    { type: "search", query: "TODO", toolName: "grep", path: "src", mode: "files_with_matches", filePaths: ["src/a.js", "src/b.js"], numFiles: 2 });
  assert.deepEqual(toolDetail("Grep", { pattern: "x", output_mode: "content" }, "a.js:1:x"),
    { type: "search", query: "x", toolName: "grep", mode: "content", content: "a.js:1:x" });
  assert.deepEqual(toolDetail("Glob", { pattern: "*.md" }, "a.md\nb.md\n(Results are truncated. Consider a narrower pattern.)"),
    { type: "search", query: "*.md", toolName: "glob", filePaths: ["a.md", "b.md"], numFiles: 2, truncated: true });
  assert.deepEqual(toolDetail("Glob", { pattern: "*.zz" }, "No files found"), { type: "search", query: "*.zz", toolName: "glob", numFiles: 0 });
  assert.deepEqual(toolDetail("WebSearch", { query: "northwind bakery hours" }), { type: "search", query: "northwind bakery hours", toolName: "web_search" });
});

test("fetch, sub-agent, todos, plan, skill", () => {
  assert.deepEqual(toolDetail("WebFetch", { url: "https://example.com", prompt: "summary" }, "text"),
    { type: "fetch", url: "https://example.com", prompt: "summary", result: "text" });
  assert.deepEqual(toolDetail("Task", { subagent_type: "code-reviewer", prompt: "Review it\nthoroughly" }, "done"),
    { type: "sub_agent", subAgentType: "code-reviewer", description: "Review it", log: "done" });
  assert.deepEqual(toolDetail("Agent", { description: "Look" }, "x", { bodies: false }), { type: "sub_agent", description: "Look", log: "" });
  assert.deepEqual(toolDetail("TodoWrite", { todos: [{ content: "Call juno", status: "in_progress", activeForm: "Calling juno" }, { content: "x", status: "weird" }, 3] }),
    { type: "todo", todos: [{ content: "Call juno", status: "in_progress", activeForm: "Calling juno" }, { content: "x", status: "pending" }] });
  assert.deepEqual(toolDetail("ExitPlanMode", { plan: "1. Fix" }), { type: "plan", text: "1. Fix" });
  assert.equal(toolDetail("ExitPlanMode", {}).type, "unknown");
  assert.deepEqual(toolDetail("Skill", { skill: "pdf" }, "loaded"), { type: "plain_text", label: "pdf", icon: "chat", text: "loaded" });
});

test("unknown tools keep their input and output; mcp names split", () => {
  assert.deepEqual(toolDetail("mcp__kit__search_notes", { q: "lease" }, "none"),
    { type: "unknown", name: "mcp__kit__search_notes", server: "kit", tool: "search_notes", input: { q: "lease" }, output: "none" });
  assert.deepEqual(toolDetail("Mystery", null), { type: "unknown", name: "Mystery", input: null, output: null });
  assert.deepEqual(toolDetail("Mystery", { a: 1 }, "x", { bodies: false }), { type: "unknown", name: "Mystery" });
  assert.deepEqual(toolDetail(/** @type {any} */ (undefined), [1]), { type: "unknown", name: "", input: [1], output: null });
  assert.deepEqual(splitMcp("mcp__claude_ai_Drive__search"), { server: "claude_ai_Drive", tool: "search" });
  assert.equal(splitMcp("Bash"), null);
});

test("labels: humanize, server labels without the vendor prefix", () => {
  assert.equal(humanize("search_notes"), "Search notes");
  assert.equal(humanize("codeReviewer"), "Code reviewer");
  assert.equal(humanize("a/b.c"), "a/b.c");
  assert.equal(humanize("mcp__x__y"), "mcp__x__y");
  assert.equal(humanize(""), "");
  assert.equal(serverLabel("claude_ai_Google_Drive"), "Google drive");
  assert.equal(serverLabel("kit"), "Kit");
});

test("display: a title, a one-line subtitle and a known icon for every type", () => {
  const cases = [
    [toolDetail("Bash", { command: "npm test\n--watch" }), { title: "Shell", subtitle: "npm test", icon: "terminal" }],
    [toolDetail("Read", { file_path: "a.md" }), { title: "Read", subtitle: "a.md", icon: "file" }],
    [toolDetail("Edit", { file_path: "a.js" }), { title: "Edit", subtitle: "a.js", icon: "edit" }],
    [toolDetail("Write", { file_path: "a.js" }), { title: "Write", subtitle: "a.js", icon: "edit" }],
    [toolDetail("Grep", { pattern: "x", path: "src" }), { title: "Search", subtitle: "x in src", icon: "search" }],
    [toolDetail("WebSearch", { query: "q" }), { title: "Web search", subtitle: "q", icon: "search" }],
    [toolDetail("WebFetch", { url: "https://example.com" }), { title: "Fetch", subtitle: "https://example.com", icon: "login" }],
    [toolDetail("Task", { subagent_type: "code_reviewer", description: "d" }), { title: "Code reviewer", subtitle: "d", icon: "agents" }],
    [toolDetail("Task", {}), { title: "Task", subtitle: "", icon: "agents" }],
    [toolDetail("TodoWrite", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] }), { title: "Todos", subtitle: "1 of 2 done", icon: "check" }],
    [toolDetail("ExitPlanMode", { plan: "Step one\nStep two" }), { title: "Plan", subtitle: "Step one", icon: "lines" }],
    [toolDetail("mcp__claude_ai_Slack__send_message", { channel: "#bakery", text: "hi" }), { title: "Slack: Send message", subtitle: "#bakery", icon: "settings" }],
    [toolDetail("Mystery", {}), { title: "Mystery", subtitle: "", icon: "settings" }],
  ];
  for (const [d, want] of cases) {
    assert.deepEqual(toolDisplay(/** @type {any} */ (d)), want);
    assert.ok(TOOL_ICONS.includes(/** @type {any} */ (want).icon));
  }
  assert.deepEqual(toolDisplay(toolDetail("Skill", { skill: "pdf" }), "Skill"), { title: "Skill", subtitle: "pdf", icon: "chat" });
  assert.deepEqual(toolDisplay(/** @type {any} */ (null)), { title: "Tool", subtitle: "", icon: "settings" });
  assert.equal(toolDisplay(toolDetail("Bash", { command: "x".repeat(400) })).subtitle.length, 300);
});
