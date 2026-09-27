# cc-plugin

Branch: work/cc-plugin · Worktree: ../vyre-cc-plugin · ADR: 0020

Scope: any Claude Code user can `/plugin install` Vyre (hooks, the `vyre` MCP server, `/vyre`,
skills), with or without Vyre on the machine; and Vyre's line in every session's status line.

## How a user installs it

Once the CI team has published `vyre-ai/vyre` on GitHub, inside Claude Code:

```
/plugin marketplace add vyre-ai/vyre
/plugin install vyre@vyre
```

Or from a shell: `claude plugin marketplace add vyre-ai/vyre && claude plugin install vyre@vyre`.
Before publishing, a checkout works the same way: `claude plugin marketplace add /path/to/vyre`.

- With Vyre installed and `vyre up` done: full features, the same hooks and tools as the threads
  Vyre starts itself.
- With no Vyre: the first line of each new session says `The Vyre plugin is on, but Vyre is not
  installed. Set it up: https://vyre.run/start`. When vyre is on npm, flip `ON_NPM` in
  `harness/lib/vyre.js` to add `(or: npm install -g vyre && vyre up)`. Nothing else happens.
- Status line, separately, in a terminal: `vyre statusline install` (asks first; `--chain` keeps
  a status line you already have). `vyre up` on a Mac offers it once. `vyre statusline uninstall`
  puts things back.

## Done

- `d347015` marketplace manifest, launchers (`harness/hooks/run.js`, `harness/mcp/run.js`,
  `harness/lib/vyre.js`), `/vyre ask|send|statusline`, Learning's hook guard covers `hooks/run.js`,
  `test/cc-plugin.test.js`.
- `cd75da3`, `4c6696e` `core/statusline` module, `harness/statusline/statusline.sh`,
  `vyre statusline [install|uninstall]` with tests.
- `a50dff2` `vyre up` offers the status line on the person's own terminal (never under node --test).
- `7d3469b` ADR 0020, SPEC section 8, CHANGELOG. `aa3ba8e` the no-Vyre line points at
  https://vyre.run/start (npm form behind `ON_NPM`); the fallback MCP server keeps the hub rule.

Verified:
- End to end from GitHub (27 Sep, after ci's rewrite), temp `HOME` and `CLAUDE_CONFIG_DIR`:
  `claude plugin marketplace add 'vyre-ai/vyre#work/cc-plugin'` and `claude plugin install vyre@vyre`
  succeed (commit aa3ba8e, cache `plugins/cache/vyre/vyre/0.0.1/` holds harness/ alone). From that
  copy: no Vyre prints the vyre.run/start line; a Vyre package on PATH with a temp home and vyred
  down gives the floor's vault deny; a package with no home says to run `vyre up`; `claude mcp list`
  shows `plugin:vyre:vyre` connected. Main has no `.claude-plugin/` until this branch merges, so the
  plain `vyre-ai/vyre` form works only after that.
- `statusline.sh` drains Claude Code's stdin when it is not chaining: exiting with it unread made
  the writer fail with EPIPE (seen once in the install test on the test box). Still 3.96 ms mean,
  4.44 ms p95 with a 600-byte stdin. The statusline cli test then passed 5 runs in a row.
- Merged to main at c4bf9ea. Plain form from public main (205387e), temp config:
  `claude plugin marketplace add vyre-ai/vyre`, `claude plugin install vyre@vyre`, the no-Vyre
  line, `plugin:vyre:vyre` connected, `claude plugin uninstall vyre@vyre`: all pass.
- docs/using/claude-code.md (work/docs 7421fb5) reviewed for accuracy; corrections sent to docs
  (drop the local-path snag, backup only when settings.json exists, empty line while vyred is
  down, the up offer only on a terminal).
- A `vyre` on PATH that is not the Vyre package (the old prototype's bin/ on this Mac) is skipped,
  and the search goes on down PATH.
- `claude plugin validate . --strict` and `claude plugin validate harness --strict` pass (2.1.283).
- In a temp `HOME` and `CLAUDE_CONFIG_DIR`: marketplace add + install succeed; `claude plugin details vyre@vyre`
  lists 4 skills (including the `vyre` command), 6 hooks, the MCP server, about 326 always-on tokens;
  `claude mcp list` shows `plugin:vyre:vyre` connected with no Vyre home.
- An installed plugin and `--plugin-dir` of the same name: only the `--plugin-dir` copy loads
  (tested with marker hooks), so Vyre's own threads never run the hooks twice.
- Tests on the test box: `test/cc-plugin.test.js`, `test/harness.test.js`, `core/learn/learn.test.js`: 64/64;
  `up`, `statusline` (cli and module), `cc-plugin`: 45/45.

Perf:
- No-Vyre hooks: about 20 ms each on the Mac (node start included). No network, no disk writes.
- Status line script, 100 runs: 3.87 ms mean / 4.27 ms p95; chained with `echo hi`: 8.00 / 8.95;
  no file: 3.77 / 3.91.
- `scripts/perf-check` on the test box (load 4.6 from other teams): p95 CPU 0.00%, RSS mean 96.6 MB,
  max 137.6 MB, no timer under 60 s. The sustained-CPU line fails at 13.1%, and fails the same way
  on main 7edfbfa (12.75%), so it predates this branch: the startup indexing tail, not statusline.

## Done: the session knows the user (27 Sep)

- `c4a30dd` core/about module + about.md, the hook reads it, `/vyre todo|remind|agenda|remember|lesson`,
  MCP instructions for memory_answer and planner_add. ADR 0020 addendum.
- Tests on the test box: core/about, cc-plugin (a stand-in planner module in the home, called
  through the copied plugin's MCP server), harness, hygiene, modules: 54/54.
- SessionStart hook with about.md and vyred down, on the Mac: 41 ms median, 47 ms p95, nearly all
  node start and hook.js's imports; reading the file is well under 1 ms. The no-Vyre path is
  unchanged (about 20 ms).

## Done: stand-ins replaced (28 Sep)

- `749317f`, `1505f42` on main c48959b: `/vyre todo|remind|agenda` use the planner's merged shapes
  (planner.add {text, kind?}, planner.list {kind: "todo"}, planner.agenda {from?}); a reminder is
  `{text: "remind me <when> <what>"}` so parse.js reads the time. `f39404e`: core/about reads
  memory-iq's `memory.profile {limit: 12}` and keeps kinds work, place, preference only (no people,
  vehicles, clients); `/vyre remember` calls `memory_remember` and offers a lesson when refused. Real client names in tests replaced by the sample world.
- End to end on the test box, a scratch tree of this branch + work/planner (8acf291) + work/memory-iq
  (23d25ac): test/cc-plugin (the real planner through the copied plugin's MCP server: remind in
  2 hours, todo, list, agenda, a no-time reminder refused), core/about, test/harness,
  core/planner/planner, core/memory/personal/answer: 46/46. Again at e1bd6cb (main 964af29) with
  memory-iq 9cec54f: 48/48. With planner ee8c92e (bare times, the agent rule, bare "mcp" is the
  user's session): 50/50. The integrator's failing trial was ddf4653, before the rewrite. This branch alone (stand-in): 15/15.
- SessionStart hook with about.md, vyred down, 30 runs on the Mac (load 2.6): 43 ms median, 47 ms
  p95 net of the timer (bare node 21 ms). Imports are about 13 ms, 10 of them core/daemon/client.js.

## Done: the plugin through the Agent SDK (27 Sep, ADR 0030 phase 2)

- `scripts/cc-plugin-parity/parity.mjs` (testbox; header says how). One Claude Code binary (the
  SDK's bundled 2.1.283), a fake Messages API, fresh temp HOME/config/Vyre home per mode, vyred up,
  about.md written. Modes: terminal (`claude plugin install vyre@vyre`, `claude -p`), sdk
  (`query()` with `plugins: [{ type: "local", path: harness }]`, settingSources user/project/local,
  no allowedTools so every call reaches canUseTool), both (installed plugin + the SDK option).
- Result, identical in all three: plugin `vyre` loaded, `plugin:vyre:vyre` connected, 220
  `mcp__plugin_vyre_vyre__*` tools, /vyre and the 3 skills; about.md's text in the first API
  request; system_echo and planner_add answer over MCP; the Write is recorded in harness_files;
  hook runs brief 1, enrich 1, rules 4, learn 1, stop 1, MCP server 1 (both: no piece twice);
  the vault Read is denied by PreToolUse and never reaches canUseTool.
- Found and fixed on the way: with vyred up, that vault Read was NOT denied (in every mode, and
  on main). The registry's floor refused `harness.rules` itself (its input holds the vault path),
  and the hook read `denied` as no opinion. hook.js now runs the local floor on `denied`.
  Test "a Read or a cat into the vault is denied" (failed before, passes now).
- Tests on testbox: test/cc-plugin, test/harness, core/learn/learn, core/about: 74/74.
- SessionStart hook after merging main ef51363, Mac, 30 runs: 40.8 ms median, 43.7 ms p95
  (bare node 19.6 / 21.5). The fix touches only the rules piece.

## Done: remember, then answer (27 Sep)

- Test "memory: the user's own session remembers a fact and is answered from it; an agent's
  session is refused": /vyre remember's `memory_remember` "My wife is Jordan.", then a fresh
  server's `memory_answer` "who is my wife" -> "Your wife is Jordan." (also with project_cwds);
  VYRE_AGENT=kit is refused both. On a scratch tree of this branch + work/memory-iq 6f2c57c:
  cc-plugin, core/memory/personal/answer, core/about: 26/26. This branch alone: 13 pass, that
  test skips with the reason. Drop the skip once 6f2c57c is on main.

## Doing

- Nothing running.

## Next

- After memory-iq 6f2c57c merges: remove the skip in the memory test.
- When vyre is on npm: set `ON_NPM = true` in `harness/lib/vyre.js`.
- If the hook's p95 creeps past 50 ms: import core/daemon/client.js lazily in hook.js (harness
  owner's file; ask first).

## Needs from others

- switchboard/sessions: on Linux (testbox, and so the box) /bin/sh is dash, which forks for
  `sh -c 'node .../run.js brief'`, so the hook's parent is `/bin/sh`, not claude. threads.bind
  refuses it ("not a running claude") and no session binds (0 rows in every parity mode), so the
  MCP server cannot name the session its calls come from. Suggested fix, daemon side (no cost to
  the hook): Sessions.bind accepts a pid that is `sh -c` whose parent is claude and binds that
  parent. The Mac's /bin/sh execs, so it binds there.

- integrator: merge memory-iq 6f2c57c (the bare-mcp gate) with or before this branch; the memory
  test skips until then.
- planner (settled 28 Sep): shapes adopted as merged; no {day, days} sugar needed. Told them a bare
  "mcp" caller is the user's own session (no label, may edit what it added); mcp:agent:<name> is
  an agent. Delivery of a due reminder: push + Capsule + Deck, not a Claude session. The agent
  rule is in ee8c92e: anyone adds anything with no prompt; bare "mcp" has source "mcp" and no label;
  `at` takes words ("6pm", "in 20 minutes"); agenda todos include overdue ones.
- docs: parked text in work/docs docs/work/pending-cc-plugin.md, applied after c4a30dd/2d9a274 merge. Its
  "agents: 20 an hour, only a person edits" line is superseded: agents add freely (silent ~200/hour cap),
  labelled only when not the user's own assistant or session. Told docs.

- ci: publish `vyre-ai/vyre` with `.claude-plugin/marketplace.json` at the root. Keep
  `harness/.claude-plugin/plugin.json`'s version equal to `package.json` on release (a test checks).
- connectors (settled): `vyre mcp` exists on work/connectors and imports `harness/mcp/server.js`.
  `mcp/run.js` does the same (import, never spawn, so Claude Code stays the server's parent and
  its session key is found), passes the env through, writes only JSON-RPC, and its no-Vyre
  fallback refuses every request with -32000 under `VYRE_HUB_CHILD`. Nothing to change when
  work/connectors merges: its server.js changes arrive through the same import.

## Changed contracts

- `/vyre remember <fact>` is a memory fact now; lessons are `/vyre lesson <rule>`.
- New module `about`, tool `about.text` (not offered over MCP), file `<home>/about.md`.
- SessionStart additionalContext now starts with about.md's text for a person's own session and the assistant.

- `harness/hooks/hooks.json` runs `hooks/run.js <piece>`, and `harness/.mcp.json` runs `mcp/run.js`.
  `hook.js` and `server.js` are unchanged and still run directly.
- New env `VYRE_PACKAGE`: the Vyre package the launchers use, ahead of any other.
- New module `statusline` with tool `statusline.line` (not offered over MCP); file `<home>/statusline`
  (pid, line); `<home>/statusline.sh`, `statusline.prev`, `statusline.prev.json`, `statusline.declined`.
- `core/learn/checks.js`: `hooks/run.js` counts as a hook entry.
- `mac()` in `core/cli/commands/up.js` takes a `statusline` dep.
