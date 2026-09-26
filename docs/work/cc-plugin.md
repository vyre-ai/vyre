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

- `c33635b` marketplace manifest, launchers (`harness/hooks/run.js`, `harness/mcp/run.js`,
  `harness/lib/vyre.js`), `/vyre ask|send|statusline`, Learning's hook guard covers `hooks/run.js`,
  `test/cc-plugin.test.js`.
- `d3291b5`, `ad3e5b7` `core/statusline` module, `harness/statusline/statusline.sh`,
  `vyre statusline [install|uninstall]` with tests.
- `07582bd` `vyre up` offers the status line on the person's own terminal (never under node --test).
- ADR 0020, SPEC section 8, CHANGELOG.

Verified:
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

## Doing

- Nothing in progress. Queued to merge after work/connectors.

## Next

- Once `vyre-ai/vyre` is public: install from GitHub in a temp config and confirm the cache copy
  finds the npm-installed `vyre` on PATH.
- When vyre is on npm: set `ON_NPM = true` in `harness/lib/vyre.js`.

## Needs from others

- ci: publish `vyre-ai/vyre` with `.claude-plugin/marketplace.json` at the root. Keep
  `harness/.claude-plugin/plugin.json`'s version equal to `package.json` on release (a test checks).
- connectors (settled): `vyre mcp` exists on work/connectors and imports `harness/mcp/server.js`.
  `mcp/run.js` does the same (import, never spawn, so Claude Code stays the server's parent and
  its session key is found), passes the env through, writes only JSON-RPC, and its no-Vyre
  fallback refuses every request with -32000 under `VYRE_HUB_CHILD`. Nothing to change when
  work/connectors merges: its server.js changes arrive through the same import.

## Changed contracts

- `harness/hooks/hooks.json` runs `hooks/run.js <piece>`, and `harness/.mcp.json` runs `mcp/run.js`.
  `hook.js` and `server.js` are unchanged and still run directly.
- New env `VYRE_PACKAGE`: the Vyre package the launchers use, ahead of any other.
- New module `statusline` with tool `statusline.line` (not offered over MCP); file `<home>/statusline`
  (pid, line); `<home>/statusline.sh`, `statusline.prev`, `statusline.prev.json`, `statusline.declined`.
- `core/learn/checks.js`: `hooks/run.js` counts as a hook entry.
- `mac()` in `core/cli/commands/up.js` takes a `statusline` dep.
