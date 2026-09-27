# native-core

## Scope
Own the NATIVE CORE milestone end to end: chat on the Claude Agent SDK that feels as native and
smooth as the Claude Code terminal (and Paseo), plus complete Settings at account and project level.
The bar: the user does a full working day in Vyre chat instead of the terminal and doesn't want to go
back.

Definition of done: the user uses Vyre chat for a full working day instead of the terminal.

## Done
- 2026-09-27 77faf1e3: core/settings (registry of ~70 keys, stores: settings_values, config.json,
  module tools, Claude Code files), settings.schema/get/set/reset/resolve, settings.changed,
  `vyre config`. 11/11 tests on testbox. CALL_AS lets settings pass a person's change on.
- 2026-09-27 0dc1f26c: Deck Settings draws every registry key (deck/views/settings-keys.js),
  Account|Project switch, source chips, optimistic save + rollback, live settings.changed.
  13/13 fake-DOM tests; not yet seen in a real browser.
- 2026-09-27: audits of sessions, chat, settings and Paseo (findings in the gap list sent to the
  lead). docs/design/settings-inventory.md and docs/design/native-bar.md written.

## Doing
- The native-bar harness (deck/test/native-bar/), fake bursty stream, testbox Chrome.

## Known follow-ups
- The new Notifications group duplicates the old Notifications section (both write push.settings):
  fold the old one into the registry view, keep devices + test there.
- Screenshots of Settings in one world (needs a Chrome run on testbox).
- Canvas Settings.dc.html has list+detail with value summaries, J/K / Space keys, "Saved" check:
  not matched yet.
- docs-check fails on main already: docs/using/claude-code.md:107 settings.json.vyre-backup (cc-plugin/docs).
- sessions must read settings.resolve at thread start (model.fallback, effort, permissions.mode,
  sessions.max_turns, sessions.budget_usd, sessions.checkpoints, fast).

## Changed contracts
- core/modules/index.js CALL_AS: settings may call as cli/local/deck/capsule.
- scripts/lib/docs/check.js OWNERS: + native-core.

## Next (1-week plan)
1. Day 1-2: core/settings registry + adapters, `settings.*` tools, `settings.changed`,
   `vyre config`. Tests in a temp home.
2. Day 2-3: Settings screens (Account and Project tabs) per design A: Models and thinking,
   Permissions, Prompt, Sessions and concurrency, Tools (MCP, hooks, env, plugins), Notifications,
   Memory, Vault, Files, Network. Effective value + source + reset on every row.
3. Day 3-4: stream smoothness in chat (with chat): Paseo paced reveal, tail-block-only markdown,
   intent-only detach, one commit per frame, stream.reset handling, draft persistence.
4. Day 4-5: native-bar harness on testbox, numbers for Vyre, terminal, Paseo.
5. Day 5-7: dogfood a full day on the box; fix what hurts.

## Needs from others
- sessions: commit step 6; rewind (resumeSessionAt + enableFileCheckpointing + rewindFiles);
  thinking deltas as kind:"reasoning"; setModel/effort/fallback; supportedCommands; images;
  tool input + capped output on thread.tool; keep mode across resume; initial permissionMode.
- chat: align names (mode.changed, queued_id, threads.send-now); stream.reset; jank fixes.
- app-design: tokens + design A frames for Settings (account/project).
- polish-cli: `vyre config` verb shape agreed with me.
