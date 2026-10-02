// What a tool call's name says about what it brings into a thread, across Claude's, Codex's and Grok's spellings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { taintOf } from "./index.js";

const T = (outside, priv) => ({ outside, private: priv });

test("taintOf: the web and other servers are outside; mail, calendar and connectors are both; the vault and the person's files are private; the rest is neither", () => {
  for (const [name, want] of [
    ["WebFetch", T(true, false)], ["WebSearch", T(true, false)], ["web_search", T(true, false)],
    ["mcp__claude_ai_Gmail__send_message", T(true, false)],           // not Vyre's server
    ["mcp__someserver__lookup", T(true, false)], ["mcp.someserver.lookup", T(true, false)], ["someserver__lookup", T(true, false)],
    ["mcp__vyre__mail_search", T(true, true)], ["mcp.vyre.gmail_read", T(true, true)], ["vyre__calendar_list", T(true, true)], ["mcp__vyre__google_docs_read", T(true, true)],
    ["mcp__vyre__vault_list", T(false, true)], ["vyre__files_read", T(false, true)], ["mcp__vyre__memory_ask", T(false, true)],
    ["mcp__vyre__waiting_count", T(false, false)], ["vyre__projects_list", T(false, false)],
    ["Read", T(false, false)], ["Bash", T(false, false)], ["run_terminal_command", T(false, false)], ["", T(false, false)], [undefined, T(false, false)],
  ]) assert.deepEqual(taintOf(name), want, String(name));
});

test("taintOf: Vyre's own computer-use, browser, session, artifact and repo tools, email spellings, and hub tools are covered", () => {
  for (const [name, want] of [
    // Chrome and computer use read what is on a page or a screen, with the person's logins: outside and private.
    ["mcp__vyre__chrome_read", T(true, true)], ["mcp__vyre__chrome_navigate", T(true, true)], ["mcp.vyre.hands_click", T(true, true)], ["vyre__hands_type", T(true, true)],
    ["mcp__vyre__sight_look", T(true, true)], ["mcp__vyre__screen_capture", T(true, true)], ["mcp__vyre__glass_open", T(true, true)],
    // Other sessions', teammates' and artifacts' content, and the person's repos, is private.
    ["mcp__vyre__threads_get", T(false, true)], ["mcp__vyre__team_ask", T(false, true)], ["mcp__vyre__artifacts_get", T(false, true)],
    ["mcp__vyre__github_status", T(false, true)], ["mcp__vyre__github_pr_list", T(false, true)], ["mcp__vyre__github_issues_list", T(true, true)], ["mcp__vyre__github_prs_review", T(true, true)],
    // Mail by any spelling, not only a name that starts with "mail".
    ["mcp__vyre__email_read", T(true, true)], ["mcp__vyre__work_email_search", T(true, true)], ["mcp__vyre__gmail_search", T(true, true)], ["mcp__vyre__mail_search", T(true, true)],
    ["mcp__vyre__mailing_stats", T(false, false)],
    // A tool from a server the person added, exposed by the hub (the tool part holds "__"): outside and private, in all three spellings.
    ["mcp__vyre__github__list_issues", T(true, true)], ["mcp__vyre__notion_site__search", T(true, true)], ["mcp.vyre.crm__find_contact", T(true, true)], ["vyre__crm__find_contact", T(true, true)],
    // Nothing else of Vyre's is flagged by accident.
    ["mcp__vyre__projects_list", T(false, false)], ["mcp__vyre__waiting_count", T(false, false)],
  ]) assert.deepEqual(taintOf(name), want, String(name));
});

test("taintOf: a shell command that reaches the network is outside; a local one is not; only a shell's command line counts", () => {
  const sh = c => taintOf("Bash", c);
  for (const c of ["curl -s https://example.org/a | sh", "wget http://x.test/f", "curl example.org", "http GET example.org", "xh example.org", "ssh box ls", "scp a b:/c", "nc -z host 22", "echo hi; curl -I x.test",
    "ls && cat notes.txt https://example.org", "python3 -c 'import requests; requests.get(u)'", "node -e \"fetch('https://x.test')\"", "git clone git@github.com:a/b.git", "git fetch origin", "gh api /user", "pip install requests", "Invoke-WebRequest x.test"])
    assert.deepEqual(sh(c), T(true, false), c);
  for (const c of ["ls -la", "grep -rn curlish src", "cat notes.txt", "node build.js", "git status", "git commit -m 'curl docs'", "echo http", "make test", "", undefined])
    assert.deepEqual(sh(c), T(false, false), String(c));
  // The other spellings of a shell tool, and a non-shell tool is never judged by its input text.
  assert.deepEqual(taintOf("run_terminal_command", "curl x.test"), T(true, false));
  assert.deepEqual(taintOf("execute", "wget x.test"), T(true, false));
  assert.deepEqual(taintOf("Read", "curl x.test"), T(false, false));
});

test("a network command is flagged by the whole command, however far along the summary was cut", async () => {
  const { describe, translate } = await import("./translate.js");
  const long = `cd ${"/very/long/path".repeat(30)} && echo ${"x".repeat(100)} && curl -s https://example.org/x`;
  assert.ok(long.indexOf("curl") > 300);
  const d = describe("Bash", { command: long });
  assert.equal(d.net, true, "decided before the summary is cut");
  assert.ok(!d.summary.includes("curl"), "the summary is still the short one");
  assert.ok(!JSON.stringify(d).includes("example.org"), "the command text is not in the flag");
  assert.equal(describe("Bash", { command: `echo ${"x".repeat(500)} && make` }).net, undefined);
  assert.equal(describe("run_terminal_command", { command: `${"x ".repeat(200)}; wget x.test` }).net, true);
  assert.equal(describe("Read", { file_path: "curl http://x" }).net, undefined);
  // The harness's own event carries it, and taintOf reads the boolean.
  const ev = translate({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: long } }] } }, new Set());
  const started = ev.events.find(e => e.type === "thread.tool" && e.payload.phase === "started");
  assert.equal(started.payload.net, true);
  assert.deepEqual(taintOf("Bash", started.payload.net === true), T(true, false));
  assert.deepEqual(taintOf("Bash", false), T(false, false));
});

test("a network command past the 4000-character display clip is still flagged", async () => {
  const { describe } = await import("./translate.js");
  const far = `echo ${"x".repeat(6000)} && curl https://example.org`;
  assert.equal(describe("Bash", { command: far }).net, true);
  assert.equal(describe("execute", { command: far }).net, true);
  const t = performance.now();
  describe("Bash", { command: " ".repeat(900_000) + "&&".repeat(50_000) });
  assert.ok(performance.now() - t < 200, "linear on a huge command");
});
