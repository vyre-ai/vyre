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

## Doing (after LOGOUT 4 resume, 2026-09-27)
NOW (22d8fae9, WIP, NOT TESTED): hub steps 2 and 3 + theme routes + secrets out of hub.json + chip
events. A run before the lead's testbox hold showed step 2 breaking settings.set in hub.test.js
worlds (hung; I stopped my pids). FIRST when testbox frees: run core/settings/hub.test.js alone,
find why settings.set stops writing (check: atOf, change(), mirror), then settings.test.js,
settings-keys, backup, daemon. Batch-4 fixes live in integrator f7226849 (carry in on next main
merge; review it). Side branch work/native-core-b4fix adb8df46 is superseded.

LATEST (ac34c322, pushed): e2e signed off 3ae4fc93 (secret masking). Since then: no-passkey text
in plain words (90617c03); ADR 0035 accepted (b95cc4dc); hub step 1 = hub.json with rev, live hand
edits, pending asks, .bad on broken JSON, backup (243b016a); platform's validateDecls rules; e2e
MEDIUMs fixed (98412a66); main 53cd1326 merged. 166/166 targeted + Chrome 7/7 on testbox.
Next: hub step 2 (device and session levels, LEVELS gains them, settings.snapshot with device
echo; default device = the caller's own), then step 3 (check/choicesFrom calls with 500 ms
deadline), then the Deck following rev. Ping mobile after steps 1-2 land on main. Merge e2e's
claudeHome switch when on main.

DONE on resume: main 7880dfa6 merged (e9b22592); e2e HIGH 1 + HIGH 2 fixed (6fb87f4e: PERSON_ONLY
settings.set/reset, agent labels refused, CALL_AS for settings limited to registry.settingTools());
store limits merged (b172c2d0 + 67abc47f); sent e2e 62abf2cf for re-review. Waiting on e2e sign-off.
Also done on resume: typing lag (e91f970c, composer grow via field-sizing; budget 1 passes 24 ms at
2,000 rows), scroll jump re-measured (fixed on work/chat 553017a1, 0 px), reconnect 1.5 s still
(pwa/resilience), agent Effort saved (87fb03d7), ADR 0035 the settings hub drafted (docs/adr/0035).
Deck confirm/proof checked in real Chrome (57a59f86, deck/test/settings-browser.js 7/7; enum labels,
where only for files). Open defects seen: the no-passkey error reads as dev text ("enroll one with
presence.enroll"); fling (budget 6) 67 ms p95; open cold (7) 2.4 s; send to row (9) 102 ms.
Next: coordinate ADR 0035 with app-design, platform, pwa, mobile, capsule-pro, sessions; build
step 1 (hub.json store) once the lead OKs the ADR; Deck confirm/proof check in a real browser.
Older list (kept for reference):
4. Typing lag: my tree's 2,000-row paint p95 48 ms (> 33) from composer.js:70 grow() over an
   unwindowed timeline. Rebase composer work on chat c26f868 (chat handed composer.js,
   pickers.js, caps.js, core/composer-state.js back to me). Fix grow (field-sizing: content or
   rAF-batched, contain: layout) + take chat's windowing. Then drafts, @ scoped to cwd, hide
   absent chips. Image drop is done by chat.
5. Scroll jump re-measure (chat's fix) and reconnect on work/pwa (0af372a overlay pill, follow()).
6. Agent "Effort" saves nothing: fix in core/agents (unowned; mine now) with a test.
7. THE CENTRAL HUB (user directive): settings + session configs + ALL design tokens in one hub,
   read live by every surface (/theme.css, /v1/theme, settings.changed), levels account >
   project > device > session, one hand-editable file under the home that emits
   settings.changed. Write ADR 0035 (claim it). Platform's asks: hub file name + live read,
   per-key `check: {tool}`, `choices: {tool}`, sessions.prompt_layers_off; a first-party
   `theme` module (platform P4). Coordinate app-design, platform, pwa, mobile, capsule-pro,
   sessions.
8. Deck confirm/proof flow is built (70023ba2); check it in a real browser when Chrome frees.
Also: platform settings.write (e4515fb6) is approved by e2e; lands after the HIGHs.
Answer mobile: meter location (proposed lib/perf/meter.js) and server `t` on thread.text is
NOT stamped yet (ask sessions for field `t`, ms epoch).
Answer app-design: check docs/design/system specs (work/app-design c4f9bb23) paths.

## Known follow-ups
- DONE: e2e's three MEDIUMs (firstParty, drops/env/plugins confirm, asPerson).
- Merge e2e's claudeHome switch (work/e2e-noclaude 32dc0956) once it is on main: settings'
  claudeDir becomes conf().claude_dir || claudeHome(ctx.paths.root).
- Screenshots of Settings in one world (needs a Chrome run on testbox).
- Canvas Settings.dc.html has list+detail with value summaries, J/K / Space keys, "Saved" check:
  not matched yet.
- docs-check fails on main already: docs/using/claude-code.md:107 settings.json.vyre-backup (cc-plugin/docs).
- sessions must read settings.resolve at thread start (model.fallback, effort, permissions.mode,
  sessions.max_turns, sessions.budget_usd, sessions.checkpoints, fast).

- Agent "Effort" (deck/views/agents.js:480) still saves nothing: needs an agents column or a
  per-agent settings level; talk to whoever owns core/agents.

## Changed contracts
- core/agents: agents.create/update take effort; agents.list returns it (native-core owns core/agents now).
- core/switchboard threads.launch: + effort input (sessions applies it to the SDK session).
- core/modules/index.js CALL_AS: settings may call as cli/local/deck/capsule.
- scripts/lib/docs/check.js OWNERS: + native-core.

## Paseo mapping (start from Paseo, improve a little)

Source: reference/paseo (Apache 2.0). Anything ported carries: "Portions derived from Paseo,
Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0" (NOTICE is on main).
Read: root AGENTS.md, docs/architecture, agent-stream-performance, timeline-sync, design,
coding-standards, testing, qa, product, glossary, forms, data-model, agent-lifecycle, permissions,
public-docs/configuration and agent-profiles, plus the code below.

| Piece | How Paseo does it | We reuse / port | Our improvement |
|---|---|---|---|
| Stream coalescing | server agent-stream-coalescer.ts: 60 ms window, leading + trailing flush, same-message text joined, tool finish flushes at once | port the coalescer into the switchboard/sessions (ours is a flat 50 ms flush) | first delta always leading-edge; server timestamp `t` on thread.text so the native bar measures box-to-screen |
| Client commit | session-stream-reducers.ts: one commit per rAF, raced by a 48 ms timer | port the scheduler into deck/chat (chat owns) | none needed |
| Paced reveal | text-reveal.ts: ceil(backlog*dt/150), 60 Hz cap, grapheme-safe, first sight whole, snap at end | port verbatim into deck/chat/core/pace.js (chat) | same rules shared with the Capsule (Swift) and the app, one spec |
| Incremental markdown | split-markdown-blocks.ts + presentation.ts: re-parse only the tail block, rows `${id}:block:n` | port split-markdown-blocks; adapt: frozen DOM nodes, tail innerHTML only | code blocks highlighted once, on close |
| Transcript list | tanstack virtual past 100 rows, last 20 mounted, height estimates, bottom-anchor-controller (sticky/detached, intent-only detach) | adapt: our window-view + Paseo's intent-only detach rule (chat) | measured by native-bar budget 5 (no jump while scrolled up) |
| Tool rows, diffs | ToolCallDetail union, Claude tool-call mapper, diff-layout.ts, 64 KiB output cap | port the mapper shape server-side (sessions) and diff-layout (chat) | tool input streams live (thread.tool carries input + capped output) |
| Asks, questions, plan | question-form-card-core.ts (pure); a pending permission turns queue into interrupt | port question-form-card-core; copy the rule | one ask card across Deck, app, Capsule and the Needs list |
| Composer | send behaviour steer/queue/interrupt (default steer), Cmd+Enter the other; queue pills with edit/send now; drafts every 200 ms; attachments; / and @ autocomplete | port input/state.ts rules, file-mention and command autocomplete; drafts to localStorage | up-arrow history (Paseo has none); @ scoped to the session folder; hidden chips for missing tools |
| Stop | interrupt idempotent, cancel UI turn first, withdraw unread steers, 3 s timeout | port the rules (sessions + chat) | "Stopping" painted on keydown (budget 10) |
| Rewind | enableFileCheckpointing; rewindFiles; conversation via forkSession(upToMessageId); menu from capability flags (conversation, files, both) | port rewind.ts semantics (sessions has rewind with restore now) and the three-item menu | the rewound prompt returns to the composer; checkpoints are a setting (sessions.checkpoints) |
| Model, mode, thinking | setModel, setPermissionMode live; thinking change says "applies next turn" | port the setter semantics | per-purpose model map in Settings |
| Resume, reconnect | epoch + seq, drop stale, gap fetch until hasNewer false, cache tail then reconcile | follow() on work/pwa already has cursor + reset (resilience) | nothing new: measure it (budget 8) |
| Settings | three tiers: daemon config.json (zod, strict), per-project paseo.json (mtime revision guard), client prefs (zod .catch per field); screens from SettingsCard/Row/Section; provider options have no UI | adapt: the tiers become levels (account, project) plus per-device prefs; the Row shape | every option has a UI and a CLI (`vyre config`); modules declare settings in their manifest; each row says where the value comes from; Claude Code's own files shared with the terminal; confirm/proof for loosening |
| Perf | agent-stream-smoothness spec: CV < 2, p95 gap < 250 ms, seeded bursty mock | adapted as deck/test/native-bar | more budgets (keys, reconnect, send, Esc, scroll), and a terminal comparison |
| Docs | AGENTS.md "writing docs", coding-standards, glossary with forbidden synonyms | propose to docs: a glossary for Steer, Queue, Rewind, Mode | |

Built new only where Paseo has nothing: up-arrow recall, settings levels with a source per row and
Claude Code file sharing, the terminal comparison in the harness.

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
