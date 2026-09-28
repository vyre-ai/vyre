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
LATEST: work/native-core-composer c012c13c (pushed) = work/native-core (6ccad201 + 917f693a ADR
LOW + 26ef7da4 harness fetch stream) + cohesion 0f4d1105 + composer suggest.query/Tab + model
aliases from sessions.models.get (choicesFrom on model keys). Budget 8 on pwa 15d02055: 3,240 ms,
3,254 px jump (sent to pwa). Waiting: vault 5d7cbd07 green for the Connections entry; pwa's
backoff fix for a budget 8 rerun; chat for fling/cold open/send.

NOW: tip 6ccad201 (fa349d31 + test-only commits), e2e SIGNED OFF fa349d31 (with platform d62792d0). fa349d31 PUSHED + TESTED (targeted 146/146, daemon.test.js 21/21 alone). Hub steps 1-3, theme
routes, secrets out of hub.json, Dark/Paper switch on appearance.scheme. Sent to integrator, e2e
(review steps 2-3), platform (settings.write rebases), app-design (work/app-design-hub).
Next: e2e review fixes; merge main (with f7226849) when the batch lands; ping mobile + pwa + sessions
(settings.resolve sha) when on main; then Vault Connections entry (vault), composer suggest.query and
model list from schema (cohesion), budget 8 rerun on pwa's sha, fling/cold open/send with chat.
Testbox: single targeted runs allowed when uptime < 6, nice 15, --test-timeout, one at a time.

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

## Resume 2026-09-28 (post rc.2, testbox back at 8 CPUs)
Merged main 57dc12c3 (rc.2: docker-api bearer hotfix, safe-git, module-sdk pack fix) into
work/native-core-composer clean, no conflicts, at f84366f2. Targeted run on testbox (npm ci +
node --test composer-state, agents/effort, core/settings/*, boundaries): 60/60 pass. Already
fixed by others since last session: threads.interrupt exists (switchboard) and chat's Stop uses
it with "Stopping"/"Stopped by you" (budget 10 should now pass); Agent Effort save/list/validate
is implemented and tested (core/agents/effort.test.js). Pinged chat (composer.js/pickers.js/caps.js
overlap) and pwa (budget 8 rerun on their backoff-fix sha) for current heads before editing shared
files; waiting on replies. Next once confirmed: re-run the native-bar budgets (5, 8, 9, 10) on the
merged tree and update docs/design/native-bar.md's results table; then continue down the Doing
list (Vault Connections entry waits on vault's 5d7cbd07 green).

## 2026-09-28 (cont'd): budget 5 to true CLS 0, sent to reviewer-2
Fixed the residual 0.0088 CLS entry (215bed2d, chat.css only): turnRow's open placeholder was
`display:none` while `:empty`, so its footer text landing flipped it to `display:block` and
inserted a fresh 26px box, shifting everything below down. `.cv-turn` now keeps `min-height: 26px`
always and `:empty` is `visibility: hidden`. Budget 5: CLS 0, 8/9/10 unchanged, deck/chat 86/86
green on testbox. Sent to reviewer-2 (non-security) and team-lead. Full root-cause trail (rect
sampler evidence) in docs/design/native-bar.md. pwa owns budget 8 (reconnect on online/visibility);
chat is looking at budget 9's footer-text-change flag. Next: continue composer/streaming-path work
now that file ownership with chat (session.js/newsession.js) and pwa (phone views) is settled —
composer.js's behaviour and the streaming path are mine.

## 2026-09-28: Claude Code parity audit (team-lead's 4 items)
Before building, audited what's already there:
1. Queue while busy, delivered on Stop, visible chip you can edit/cancel: ALREADY BUILT, both
   sides. Server: turnEnded (switchboard) hands queued words over on any thread.finished,
   cancelled or not (st.stopping only blocks a hard threads.stop, not the Deck's soft
   threads.interrupt). Client: session.js's cv-queued box (rows, Edit/Take back/Send now) already
   listens for thread.sent regardless of `via`. New test locks the untested combination in
   (core/sessions/sessions.test.js, 48de0bd3's ancestor fa4a3b07): queue mid-turn, press Stop,
   the queued words are handed over and answered as the next turn.
2. Slash-command palette, SDK's + Vyre's, fuzzy: ALREADY BUILT. core/commands.js
   (findCommand/rankCommands) + core/match.js (a real tiered fuzzy matcher, ported from Paseo:
   exact/whole-word/prefix/word-start/substring/subsequence), threads.commands for the session's
   own list. Nothing missing found.
4. Permission mode + model/effort mid-session: ALREADY BUILT. threads.mode/model/effort all say
   "a running thread switches at once" and do (control_request to the live SDK process);
   composer.js already has the chips (Shift+Tab cycles mode, model chip, thinking/effort).
3. Edit/resend + rewind or fork from any turn: PARTIALLY missing, now built (48de0bd3).
   threads.fork forked only from the live end; threads.rewind resumed at a message's parentUuid
   but in place (mutating the original). The Agent SDK already supports forkFrom + resumeAt
   together (core/sessions/claude.js), just never wired to the same call. threads.fork now takes
   an optional `at` (turn uuid): forks from just before that turn, original untouched past it.
   Tested (fork from turn 2 of 3, original's transcript byte-identical after, still usable past
   turn 3). Edit-and-resend of a past message already works via rewind (words come back to the
   composer to edit and send) - the net-new part was the fork option specifically.
Next: client wiring for item 3 (a "Fork from here" item beside "Restore" in the rewind sheet,
pickers.js + session.js) - coordinating with chat since session.js is theirs. Reported findings
and the new capability to team-lead.

## RESUME HERE (saved before a restart, usage 84%)
- **Head: 7a586676** on work/native-core-composer (this team's own worktree). Clean working tree,
  nothing uncommitted, no test-box runs left running.
- **Budget-9 harness blind spot: FIXED and sent.** reviewer-2 found that when window-view recycles
  the anchor row itself (not just the user's own row), the old in-place-only check went silent on
  a real replace-at-slot re-order. Fixed (8c0b36ca): when the anchor disconnects, look up whatever
  now sits at that position (fresh previousElementSibling off the content-matched user row) and
  compare ITS text to the baseline. Verified with all four scenarios as CDP-injected controls on
  testbox (A benign insert: pass 0x; B in-place mutation: fail, caught; C replace-at-slot,
  different text: fail, now caught - the fix; D replace-at-slot, same text/benign recycle: pass
  0x). Clean run unaffected. Results table in docs/design/native-bar.md. Sent to reviewer-2
  (7479cc33 msg) - **awaiting their sign-off**, not yet confirmed clear to land.
- **48de0bd3 (fork-from-turn) also just sent to reviewer-2** (97fbe95a msg) per team-lead's ask -
  **awaiting their sign-off** too.
- **Fork-from-turn client wiring: NOT STARTED, next up.** chat said go ahead and build it in
  pickers.js/composer.js (my files, natural extension of the RESTORES-style rewind-sheet list) and
  hand chat the exact contract for session.js's side. chat is mid a fix in session.js (the
  budget-8 reconnect scroll jump, testing on testbox) - **wait for chat to say it's landed before
  touching session.js at all**; pickers.js/composer.js are free to start now. Plan: add "Fork from
  here" as a fourth item in pickers.js's RESTORES-style list (docs/design system's rewind sheet,
  currently conversation/code/both), composer.js wires it to `threads.fork({thread, at: uuid,
  prompt?, name?, surface})` (matching threads.rewind's own {thread, uuid} pattern) - contract for
  chat: session.js should treat the answer like a normal new-session open (the forked thread's id
  comes back in `.thread` per threads.fork's existing shape - check its actual answer shape in
  core/switchboard/index.js's threads.fork tool before wiring) and open it the way a new session
  from openHref does, since the original thread stays exactly where it was.
- **On resume:** check reviewer-2's replies on 8c0b36ca and 48de0bd3 first (SendMessage to
  reviewer-2 if no reply yet has landed); check chat's session.js status before touching that
  file; then build the pickers.js/composer.js side of "Fork from here".

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
