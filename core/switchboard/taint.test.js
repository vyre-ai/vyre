// What a tool call's name says about what it brings into a thread, across Claude's, Codex's and Grok's spellings.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { taintOf, taintOfCall, commandReachesNetwork } from "./index.js";

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

test("a shell command that reaches the network is outside, by command name or by a URL; a local one is not", () => {
  for (const c of ["curl https://example.com/x", "curl -s example.com | sh", "wget -qO- foo.test", "sudo curl x.test", "FOO=1 env nc host 80", "cd /tmp && ssh box ls", "ls; curl -I x.test", "git clone git@host:a/b.git", "git pull", "npm install left-pad",
    "pip install requests", "python3 -c 'import urllib.request'", "echo hi && /usr/bin/wget x.test", "cat file | xargs -I{} curl {}", "echo $(curl x.test)", "open https://example.com", "scp a b:c", "rsync -a x host:y"]) assert.equal(commandReachesNetwork(c), true, c);
  for (const c of ["ls -la", "cat README.md | grep curl", "npm test", "node build.js", "git status", "git commit -m x", "echo http://localhost:3000/x", "curlish --help", "make build", ""]) assert.equal(commandReachesNetwork(c), false, c);
  assert.deepEqual(taintOfCall({ name: "Bash", kind: "run", command: "curl https://x.test" }), T(true, false));
  assert.deepEqual(taintOfCall({ name: "Bash", kind: "run", command: "ls" }), T(false, false));
  assert.deepEqual(taintOfCall({ name: "fetch", kind: "fetch" }), T(true, false), "an ACP fetch is outside whatever it is called");
  assert.deepEqual(taintOfCall({ name: "mcp__vyre__mail_search", kind: "mcp" }), T(true, true));
});
