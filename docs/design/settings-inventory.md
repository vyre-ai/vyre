---
title: Settings inventory
summary: Every setting in Vyre and Claude Code, the level it is set at, where it lives, and its control.
audience: builders
owner: native-core
status: draft
---

# Settings inventory

Every option a person can set in Vyre, where it lives, and where you change it. The rule: nothing is
config-file-only. Every row here gets a control in the app (Settings) and a CLI route (`vyre config`).

Status on 2026-09-27: main c8fb9aae, plus work/sessions (9eb5d18b and its uncommitted step 6) and the
ADR 0031 design on work/teammates. "UI" and "CLI" say what exists today.

## Levels and precedence

Five levels, highest wins:

1. **This session.** A chip in the composer (model, effort, mode). Lasts for the session only. Each
   chip has "Make default for this project" and "Make default everywhere".
2. **Agent or teammate.** The agent's own record (model, prompt, tools, budget).
3. **Project.** Overrides for one project, keyed by its slug.
4. **Account.** Your defaults on this box, for every project.
5. **Built in.** The shipped default.

Claude Code's own files sit beside this, not inside it. Vyre starts every SDK session with
`settingSources: ["user","project","local"]`, so `~/.claude/settings.json`, `.claude/settings.json`
and `.claude/settings.local.json` still load. Where a Vyre value and a Claude Code value cover the
same thing, the Vyre value is passed as an SDK option and wins for sessions Vyre starts. The terminal
keeps reading only Claude Code's files.

To keep the terminal and Vyre in agreement, the options below split into two kinds:

- **Vyre-owned** (V): stored by Vyre, passed as SDK options. Model, fallback, effort, permission
  mode, system prompt, max turns, budget, concurrency, and every Vyre module setting.
- **Claude-Code-owned** (C): the source of truth stays in Claude Code's files, so the terminal sees
  the same thing. Vyre's screen reads and writes those files. Account level writes
  `~/.claude/settings.json`; project level writes `.claude/settings.local.json` (the person's own,
  never committed) unless they choose "Share with the repo" (`.claude/settings.json`). Permission
  rules, hooks, env, MCP servers (`.mcp.json`), plugins, output style, CLAUDE.md memory.

Every screen shows the effective value and where it comes from ("Project", "Account", "Built in",
"~/.claude/settings.json"), with a reset arrow to fall back one level.

## Storage plan

One registry, `core/settings`, describes every key: type, default, allowed levels, owner module,
backing store, and whether a change applies live, next session or after a restart. It adds:

- tools `settings.schema`, `settings.get {key, project?}` (effective value plus source),
  `settings.set {key, value, level, project?}`, `settings.reset`, and one `settings.changed` event;
- `vyre config list|get|set|reset [--project <slug>] [--account]`, with `--json`.

Keys keep their current backing stores behind adapters (config.json, `sessions_models`,
`sessions_prompts`, `push_state`, `planner_state`, agent rows, Claude Code files), so nothing
migrates on day one. New project overrides go in one `settings_values` table
(`scope = account | project:<slug> | agent:<name>`, key, JSON value, who, when). The project marker
stays identity only (name, slug, workspaces), because it may be committed.

## A. Claude Code and Agent SDK options

Legend: Lv = levels (S session, A account, P project, G agent/teammate). Own = V (Vyre) or C (Claude
Code files). SDK = the query() option or Query method.

| Option | SDK | Own | Lv | Default | Today | UI today | CLI today |
|---|---|---|---|---|---|---|---|
| Model | `model`, `setModel()` live | V | S A P G, plus per purpose | opus for chat, agent, project; haiku for capsule, job, memory, planner, learn | `sessions.models.<purpose>` in config.json; `sessions_models` for `purpose:`/`project:` overrides; agent row | agents.js model select only | `vyre sessions models` (polish-cli), `vyre call sessions.models.set` | <!-- terms: ignore -->
| Model per purpose | (resolves `model`) | V | A P | as above | same | none | same |
| Fallback model | `fallbackModel` | V | A P G | none | not passed | none | none |
| Effort / thinking | `effort` (low, medium, high, xhigh, max), `thinking`, `setMaxThinkingTokens()` | V | S A P G | model default | not passed; agent "Effort" select is saved nowhere (bug) | agents.js (broken) | none |
| Show thinking | (translate keeps reasoning) | V | A | shown folded | dropped by the driver | none | none |
| Fast mode | `applyFlagSettings({fastMode})` | V | S A P | off | not passed | none | none |
| Permission mode | `permissionMode`, `setPermissionMode()` live | V | S A P G | default | only live via `threads.mode`; lost on resume | Shift+Tab chip (chat branch) | none | <!-- terms: ignore -->
| Modes offered | default, acceptEdits, plan, auto, dontAsk, bypassPermissions | V | A | first three; bypass behind a confirm | first three only | none | none |
| Allow rules | `allowedTools` / `permissions.allow` | C | A P | none | Claude Code files; "Always in project" writes settings.local.json | Ask card "Always" only | none |
| Deny rules | `disallowedTools` / `permissions.deny` | C | A P G | none | Claude Code files | none | none |
| Ask rules | `permissions.ask` | C | A P | none | Claude Code files | none | none |
| Additional folders | `additionalDirectories` / `permissions.additionalDirectories` | C, V per session | S A P | none | not passed | none | none |
| System prompt | `systemPrompt` preset `claude_code` + append, or replace | V | A (assistant) P G | append, empty | `sessions_prompts`, versioned | none | `vyre sessions prompt` (polish-cli) | <!-- terms: ignore -->
| Plan mode instructions | `planModeInstructions` | V | A P | none | not passed | none | none |
| Output style | `outputStyle` in settings | C | A P | default | Claude Code files | none | none |
| CLAUDE.md memory | files | C | A (`~/.claude/CLAUDE.md`) P (`CLAUDE.md`, `CLAUDE.local.md`) | none | files | none | none |
| MCP servers for sessions | `mcpServers`, `.mcp.json`, `enabledMcpjsonServers` | C, plus Vyre hub | A P | Vyre hub only | Vyre hub via plugin; `.mcp.json` via settingSources | Connections (hub servers) | `vyre mcp` |
| MCP live toggle | `toggleMcpServer()`, `reconnectMcpServer()`, `mcpServerStatus()` | V | S | n/a | none | none | none |
| Hooks | `hooks` in settings | C | A P | Vyre Harness plugin hooks | Claude Code files, Harness plugin | none | none |
| Plugins and skills | `plugins`, `enabledPlugins`, `skills` | C, V for learned skills | A P | Harness + learned skills | driver passes Harness dir and learned skills | none | `vyre learn` |
| Env for sessions | `env` / settings `env` | C | A P | vyred env copy (should be built from nothing, ADR 0030) | full process.env copy | none | none |
| Max turns | `maxTurns` | V | A P G | unlimited for chat; set for jobs | not passed | none | none |
| Budget per session | `maxBudgetUsd` | V | A P G | none for chat; agent `budget_usd` | agent row | agents.js | `vyre call agents.update` |
| Auth mode | env `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / login | V | A (per machine) | Mac login, box setup-token, API key fallback | `sessions.auth` in config.json | none | `vyre sessions setup` (polish-cli) | <!-- terms: ignore -->
| Provider | driver router (`claude` now; codex, acp later) | V | A P G | claude | `sessions.driver`/providers | none | none |
| Claude binary | `pathToClaudeCodeExecutable` | V | A (per machine) | box bundled, Mac installed | `sessions.claude` | none | none |
| File checkpoints (rewind) | `enableFileCheckpointing`, `rewindFiles()` | V | A | on | not passed | none | none |
| Sandbox | `sandbox` | C | A P | off | not passed | none | none |
| Attribution | `attribution` / `includeCoAuthoredBy` | C | A P | Claude Code default | Claude Code files | none | none |
| Auto-compact | settings `autoCompactWindow`, `/compact` | C | A | on | Claude Code files | none | none |
| Prompt suggestions | `promptSuggestions` | V | A | off | not passed | none | none |
| Subagent text | `forwardSubagentText`, `agentProgressSummaries` | V | A | summaries on | dropped | none | none |
| Session name | `title`, `extraArgs.name` | V | S | first line | passed on new | rename in chat | none |
| Session cleanup | `cleanupPeriodDays` | C | A | 30 | Claude Code files | none | none |

Composer behaviour (Vyre-owned, account level with a session override):

| Option | Default | Today |
|---|---|---|
| Send while busy: steer, queue or interrupt | steer (the user's decision) | built in chat, needs sessions step 6 |
| Enter vs Cmd+Enter to send; Shift+Enter newline | Enter sends | built |
| Tool call detail: summary or full | summary | none |
| Always expand thinking | off | Ctrl+O only |
| Vim keys in the composer | off | none |
| Code font, content size | theme default | none |

## B. Vyre settings

| Area | Setting | Lv | Default | Today | UI today | CLI today |
|---|---|---|---|---|---|---|
| Sessions | Idle close minutes | A | 10 | `sessions.idle_minutes` | none | none |
| Sessions | Max live sessions (machine) | A | box 6, Mac no cap | `sessions.max_live` | none | none |
| Sessions | Driver (sdk or cli fallback) | A | sdk after the flip | `sessions.driver` | none | env only |
| Sessions | SDK install on first use | A | on | `sessions.install` | none | none |
| Concurrency | Preset Light 1/2, Balanced 3/4, Max 6/10, Custom | P | Balanced | ADR 0031, not built | none | none |
| Concurrency | Max active teammates 1..8, max subagents 0..16 | P | 3, 4 | not built | none | none |
| Concurrency | Box ceiling teammates, subagents | A | 6, 8 | not built | none | none |
| Concurrency | Pause at usage warning; API key fallback | P | on, off | not built | none | none |
| Teammates | Per teammate daily turns, budget, model, role prompt | G | 200 turns | not built | none | none |
| Teammates | Integrator: auto-merge when green, push after merge, test command | P | on, off, detected | not built | none | none |
| Agents | Instructions, skills, projects, computer, model, auth, budget | G | | agent row | agents.js | `vyre agents` |
| Agents | Computer CPUs, memory | G | | pool table | agents.js | call |
| Assistant | Name, instructions | A | | onboard, agents | Settings > The assistant | none |
| You | Your name, domains, emails | A | | `onboard.person`, `me.*` | name read-only | none |
| Projects | Projects folder, extra roots | A | `~/Vyre/projects` | config.json | none | none |
| Projects | Name, workspaces, people, watchers | P | | marker | read-only | `vyre new`, `pick` |
| Notifications | Kinds (ask, draft, watch, lesson, planner), quiet hours | A, per device later | all on | `push_state` | 4 of 5 kinds | call |
| Notifications | Planner label | A | off | `push_state` | none | call |
| Planner | Time zone, escalate after/max, event lead | A | system zone, 5, 3, 10 | `planner_state` | none | read only |
| Memory | Model on, daily and per-call spend | A | on, 0.05, 0.01 | config.json | none | none |
| Memory | Learn relations (prefers, decided) | A | off | config.json | none | none |
| Learn | Distill per day | A | 6 | config.json | none | none |
| Learn | Lessons (edit, retire, scope) | A P | | learn tables | Settings > Lessons | `vyre learn` |
| Recall | Index cadence, duty cycle, low battery, embedder, transcript folders | A | 5, 0.5, 30 | config.json | History (reindex only) | none |
| Presence | Passkeys | per device | | presence table | Security | `vyre presence code` |
| Vault | Lock idle, max, on sleep, on screen lock | A | 10m, 12h, on, on | config.json | none | none |
| Vault | Relay, fill, ssh agent | A | off | config.json | none | none |
| VyreDrive | Default access, shares | A | ro | config.json | Network (read-only) | call |
| Files | Roots, max fetch, dotfiles | A | | config.json | none | none |
| Terminal | Keep hours, max, shell, login, scrollback | A | 12, 8 | config.json | none | none |
| Glass | Hand-back minutes, roots, upload size, egress | A | 5 | config.json | hand-back only | call |
| Network | Name, owner, guests, origins, onboarding port, ACME | A | | config.json | read-only | `vyre name`, `owner` |
| Relay | On, URL, web link expiry | A | off | config.json | none | call |
| Webhooks | On, port, routes | A | off | config.json | read-only | `vyre hooks` |
| MCP hub | Idle minutes, HTTP hosts, per-tool mode | A | 10 | config.json, mcp tables | per-tool mode | `vyre mcp` |
| Gate | Approvers, senders | A | chat | config.json | none | none |
| Voice (Mac) | Provider, speak, voice | A | deepgram, off | config.json | none | `vyre voice` |
| Capsule (Mac) | Start at login | A | off | config.json | none | none |
| Modules | Enable, disable | A | by role | config.json | status only | none |
| Appearance | Theme, colours | per device, A for colours | dark | localStorage, config.json | Appearance (theme) | none |

## Gaps this inventory found

1. No settings API: each screen calls its module's own tool, and 40-odd keys are file-only.
2. No `vyre config` verb.
3. Sessions settings (models, prompts, idle, caps) have no screen.
4. Agent "Effort" says Saved and saves nothing.
5. Notifications miss the `planner` kind and the planner label; quiet hours are box-wide with one
   browser's time zone.
6. Most config.json keys need a restart; there is no `config.changed` event.
7. Permission mode is lost when an idle session resumes.
8. No project-level settings screen exists at all.
