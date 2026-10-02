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
