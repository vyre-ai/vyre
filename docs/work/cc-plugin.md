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

## Doing

- Waiting on memory-iq and planner to confirm the contracts below.

## Next

- When vyre is on npm: set `ON_NPM = true` in `harness/lib/vyre.js`.

## Needs from others

- memory-iq: confirm `memory.answer {question, room?, project_cwds?, agent?}` -> `{answer|null, facts[]}`,
  `memory.profile {limit?}` -> `{facts: [{text, kind, weight}]}` (owner's durable facts, nothing
  sensitive), `memory.remember {text, room?}` -> `{id, text}` (a person-taught fact). Until then
  about.md has no profile lines and `/vyre remember` offers a lesson instead.
- planner: confirm `planner.add {text, kind?: todo|reminder, at?, project?, thread?}` -> `{id, text, kind, at|null, project}`
  and `planner.agenda {day?, days?}` -> `{items: [{id, text, kind, at|null, done, project|null}]}`; who delivers
  a due reminder. Lead's decision (27 Sep), passed to planner to enforce: agents may call planner.add and
  planner.agenda (todos, reminders, notes), each item labelled with the agent and 20 per hour per agent;
  only a person edits, completes, deletes or sets a ringing alarm. The MCP server keeps planner tools
  visible to agents (its DRIVES filter hides only threads.* and agents.*).
- docs: the new `/vyre` rows and an "Every session knows you" section are sent; docs holds them until c4a30dd merges.

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
