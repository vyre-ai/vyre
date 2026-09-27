---
title: ADR 0020: Vyre as an installable Claude Code plugin
summary: Installing Vyre as a Claude Code plugin, what it does without Vyre on the machine, and Vyre's status line.
audience: builders
owner: docs
status: stable
---

# ADR 0020: Vyre as an installable Claude Code plugin

Status: accepted, 27 Sep 2026 · Workstream: cc-plugin · Spec: section 8 (the Harness)

## The problem

The Harness (`harness/`) has always been a Claude Code plugin, but only Vyre loaded it: every
thread Vyre starts passes `--plugin-dir`. A person's own `claude` in a terminal got none of it
unless they pointed `--plugin-dir` at the npm package by hand. We want any Claude Code user to
get Vyre's hooks, MCP server, commands and skills with `/plugin install`, whether or not Vyre is
on their machine yet, and to see what needs them in every session's status line.

Three facts about Claude Code 2.1.283 shaped the answer. Each was checked, not assumed:

1. `/plugin install` copies only the plugin's folder into `~/.claude/plugins/cache/<market>/<plugin>/<version>/`
   (seen in a temp `CLAUDE_CONFIG_DIR`). The Harness hooks import `../../core/...`, which is not
   in that copy.
2. A plugin cannot set `statusLine`. A plugin's `settings.json` supports only `agent` and
   `subagentStatusLine` (Claude Code's plugin reference and status line docs). Only the
   user's own `settings.json` sets the status line.
3. When a plugin named `vyre` is installed and a session also gets `--plugin-dir` with a plugin
   named `vyre`, only the `--plugin-dir` copy loads. Tested with two plugins of one name whose
   SessionStart hooks each wrote a mark: with `--plugin-dir` only the local one ran, without it
   only the installed one. So a user who installs the plugin never gets double hooks in the
   threads Vyre starts.

## Decision

**One plugin, two manifests.** `.claude-plugin/marketplace.json` at the repo root names the
marketplace `vyre` with one plugin, `vyre`, whose source is `./harness`. `harness/.claude-plugin/plugin.json`
stays the plugin's manifest, and its version follows `package.json` (a test holds them equal).
Users run:

```
/plugin marketplace add vyre-ai/vyre
/plugin install vyre@vyre
```

**Launchers, not copies of core.** `hooks.json` and `.mcp.json` start `hooks/run.js` and
`mcp/run.js`. Each asks `harness/lib/vyre.js` where Vyre is, in this order: `VYRE_PACKAGE`; the
folder the Harness sits in, when it is inside the package (the `--plugin-dir` case); the `vyre`
on `PATH`, followed through npm's symlink. When a package is found and Vyre's home exists, the
launcher imports (never spawns) that package's own `hook.js` or `server.js`, so the code that runs always
matches the vyred it talks to, and nothing about today's hooks changes. The launcher uses only
node built-ins and a few stat calls.

**Without Vyre, one line and then silence.** With no package (or a package whose `vyre up`
never ran), the SessionStart hook of a fresh session (source `startup`, not resume, clear or
compact) prints `{"systemMessage": ...}` with one line: "Set it up: https://vyre.run/start", the page that covers
both a Mac and a server (the `npm install -g vyre && vyre up` form joins it behind `ON_NPM` in
`harness/lib/vyre.js` once the package is on npm), or "run `vyre up`". Every other hook exits 0 with no output in about 20 ms. The MCP server
answers `initialize` with the same line in its instructions and lists no tools, so Claude Code
shows it connected, not failed, and `/vyre` can tell the user. Nothing is written to disk; no
`~/.vyre` is made.

**The status line is Vyre's own, installed only with consent.** A new module, `core/statusline`,
keeps `<home>/statusline`: vyred's pid and one line, for example
`vyre · 2 need you · box ok · juno idle`. It recomputes on events (a 1 s trailing debounce, capped
at 5 s) and once a minute for box reachability, and writes only when the text changes. The
command Claude Code runs is a POSIX sh script copied to `<home>/statusline.sh` at install, with
the home baked in: it prints the line if the pid is alive and nothing otherwise, never reads
stdin unless chaining, never calls vyred or the network, and always exits 0. Measured at 3.9 ms
mean, 4.3 ms p95 (8 ms chained).

`vyre statusline install` edits `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json` after a y/N on a
terminal (`--yes` skips it; with no terminal it only says what it would do). A status line the
user already has is never replaced: `install` says so and stops, `install --chain` keeps theirs,
runs it first with Claude Code's stdin, and adds Vyre's line under it. `uninstall` puts theirs
back. `vyre up` on a Mac offers it once on the person's own terminal and remembers a no. The
plugin's `/vyre statusline` only tells the user to run that command; Claude never edits their
settings.

## Consequences

- The plugin's hooks run whatever Vyre version is installed, not the version in the marketplace.
  A marketplace ahead of the package still works, because the hook pieces (`brief`, `enrich`,
  `rules`, `learn`, `fail`, `stop`) are the contract between them.
- Learning's guard against running a hook by hand now also matches `hooks/run.js` (not any
  `run.js`).
- Until the CI team publishes `vyre-ai/vyre` on GitHub, `/plugin marketplace add` takes a local
  checkout path instead.
- Rejected: shipping core inside the plugin (a second copy of the security floor that could drift
  from vyred's); a statusLine set by a SessionStart hook writing settings.json (edits a user's
  config without asking, and Learning rightly treats that as weakening); calling vyred from the
  status line (a socket round trip on every refresh, and a hang when vyred is stuck).

## Addendum, 27 Sep 2026: the session knows the user

**About you.** A module, `core/about`, keeps `<home>/about.md`: the person's name and their
assistant's (onboarding's step 1, read from config), their four busiest projects and the people in
them (`projects.list`), then what memory-iq's `memory.me` knows about their work: facts about the
user that are still true, with confidence 0.5 or more, for where they work, their role, where they
live, what they use and what they prefer. Family, birthdays and what they own stay out, because the
text reaches every project's sessions, clients' included. It recomputes 5 s after a memory, onboarding, project or agent event, writes only
on change (mode 600), and stays under 600 characters. A line is dropped whole if it looks like a
credential, a long token, an email address, a phone number or names a password, secret or key.
The SessionStart hook reads the file directly, not through vyred, so it holds when vyred is down,
and puts it ahead of the project brief as additionalContext, marked as facts, not instructions. An
agent scoped to some projects does not get it, because it names projects outside its scope; the
assistant and a person's own session do.

**Tools.** Nothing to add to the MCP server for memory-iq's `memory.answer` or the planner's
the planner's tools: it forwards every vyred tool, so they appear as `memory_answer`,
`planner_add`, `planner_list` and `planner_agenda` once those modules run. Its instructions now
tell Claude to back a promised reminder with `planner_add` in the same turn, and without it to say
Vyre cannot remind yet rather than promise.

**Commands.** `/vyre todo <text>` (`planner.add {text, kind: "todo"}`; with no text,
`planner.list {kind: "todo"}`), `/vyre remind <when> <text>` (`planner.add {text: "remind me <when>
<text>"}`, so the planner's own parser reads the time and a reminder with none is refused),
`/vyre agenda` (`planner.agenda`, `{from: "YYYY-MM-DD"}` for another day), and
`/vyre remember <fact>` (a memory fact, through `memory.remember` from memory-iq). The lesson form
that `remember` used to be is now `/vyre lesson <rule>`.
