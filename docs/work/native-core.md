# native-core

## Scope
Own the NATIVE CORE milestone end to end: chat on the Claude Agent SDK that feels as native and
smooth as the Claude Code terminal (and Paseo), plus complete Settings at account and project level.
The bar: the user does a full working day in Vyre chat instead of the terminal and doesn't want to go
back.

Definition of done: the user uses Vyre chat for a full working day instead of the terminal.

## 2026-09-28: the four avatar families (0.1.1, user decision: avatars LOCKED)
Branch work/native-core-avatars off stage/0.1.1 (4a595c99).
Done:
- deck/js/avatars.js: the ONE importer of deck/vendor/vyrecode (identity.js, creature.js, new
  characters.js = app-design round3b blob + character, vyrecode2.js/geometry.js) and
  deck/vyrecode/payload.js. API: setIdentity(system.info), readSystem/readTeammates/readIdentity,
  avatar(family, seed, {size, label, title, cls}), personAvatar({ring}), assistantAvatar,
  agentAvatar(id), teammateAvatar(id), whoAvatar(agent), teammateId(role, project),
  avatarSource (pure), installAvatarMotion. Seeds: person = owner.fingerprint8, assistant =
  assistant.fingerprint8 (both 16 hex from system.info), agent = its name (agents_agents PK),
  teammate = `<role>-<project>` (core/team agentName). Fallbacks: face/creature from the name, no ring.
- Wired: chat user rows, assistant/agent head rows, session header (.cv-head-av, 32), handoff card
  (teammate from the session's project), chat thread list, Agents page rows and board head, a new
  Teammates section on /agents (team.list), Settings > You (160 with the Vyre code ring, redraws
  on a theme switch). pair-avatar.js renders through avatars.js. sw.js precaches the new modules.
- Tap hop (deck.css .vy-av-play), off under prefers-reduced-motion; one capture listener in app.js.
- Perf: one parse per (family, seed, size band), cloned after; LRU 256; unique gradient ids per copy.
Tests (testbox): deck/js/avatars.test.js 13/13; `"deck/**/*.test.js"` + boundaries 706/706 after the
cards/session test updates; test/docs-*.test.js + boundaries 66/66; docs-check 0 problems other than
262 mtime-only shot staleness (untouched files too, environmental). Headless Chrome
(deck/test/avatars-browser.js, temp profile, testbox) 13/13: 61 avatars draw in Dark and Paper, 0
duplicate ids, every gradient ref resolves once, ring at Settings size, chat rows + header, hop, Reduce
Motion still. Native bar (avatars vs stage base): all pass except 8 (reconnect; fails on base too).
5 read CLS 0.0063 once in the full run, then 0 in 3 of 3 reruns (base 0). 7.cold 838 vs 666 ms,
9 send 12.4 vs 4.4 ms, all within budget.
Needs from others:
- anywhere (via lead): config.fingerprint8 slices 8 HEX chars (4 bytes); ADR 0043 2f says 8 bytes
  (16 hex). And system.info needs assistant.fingerprint8. Until then the assistant uses its fallback.
- app-design: the locked files (darker-skin contrast floors). Swap = deck/vendor/vyrecode/* and, if
  the API moved, deck/js/avatars.js only.
Next: swap in app-design's locked files; rerun avatars.test.js, avatars-browser.js, native bar.
Changed contracts: deck/chat/blocks.js personAv/agentAv now draw avatars (same classes kept);
handoffCard reads b.project; deck/chat/lib/names.js readNames feeds setIdentity; deck/sw.js SHELL;
deck/css/deck.css span.vy-av rules; deck/css/views/agents.css, settings.css.

## 2026-09-28 (cont'd): locked files, base64url fingerprints, project tiles, rail avatar
- Cherry-picked anywhere's owner.id (386e2049, e798ca50, 57d658d0, f3a25653; lead cleared through
  f3a25653). system.info sends owner.fingerprint8 and assistant.fingerprint8 as base64url (11
  chars). lib/identity.js is Node-only, so avatars.js decodes with atob; avatars.test.js checks the
  decode against lib/identity's own toBase64url(fingerprint8()).
- Vendored app-design's locked files (949d9e78 skin-tone floors, e84bb767 project tiles):
  identity.js, characters.js, new project.js. theme() now reaches character() and projectTile();
  a theme switch redraws every avatar on the page in place (installAvatars' MutationObserver).
- Core (own commit, for the reviewer): core/projects stores `avatar_seed` in the marker at create
  (the slug, or with `from_thread` the chat's id, which is also picked in). projects.list returns
  it; an older marker defaults to its slug and is never rewritten on read.
- Fifth family: threadAvatar() draws a session's replies and header: project tile in a project,
  dashed draft tile (the chat's id) in none, the assistant's creature only in its own thread,
  agents' blobs, teammates' characters with their project's colour badge. thread.picked re-renders
  a session's reply avatars and header in place. The header and thread rows show a short session
  id (#abc123) so sessions in one project are told apart. Project tiles in the project list and
  the chat sidebar. "New project from this" on a loose thread page (projects.create from_thread).
- Project tile bytes: projectBytes(seed) = two FNV-1a words over "vyre:project:v1:" + seed. Every
  surface drawing a project tile (the App, the Capsule) needs this same function.
- Rail account button and the phone header show the person's avatar.
- Tests (testbox): targeted `deck/**`, boundaries, `docs-*`, core/projects, core/system, core/config
  850/850 after the docs fix; docs-check shots-only (mtime); avatars-browser.js 14/14 in headless
  Chrome (93 avatars, five families, Dark and Paper, ring, chat draft tiles, rail, hop, Reduce
  Motion). Native bar: all pass but 5 and 8. Both fail on stage base too: 8 always; 5 only when
  budgets 1-4 run first, one shift of a reply's cv-head row (0.0063 to 0.0070 on base, 0.0067 here,
  diagnosed with a throwaway copy of run.js). 7.cold 815 ms, 9 send 10.1 ms.
- ddc75e75: lib/avatar-seed/index.js is the one projectBytes (pure JS, vectors in its test, checked
  against an independent BigInt FNV). vyred serves only that file at /lib/avatar-seed/index.js
  (core/daemon, next to the resilience route; test/daemon.test.js covers it); avatars.js imports
  it. Also adapted test/daemon.test.js's two system.info asserts to anywhere's fingerprint8 fields.
  Testbox 882/882 (+1 skipped), Chrome 14/14.
- Needs from app-design: avatar.md and ADR 0043 should say renaming an agent changes its blob
  (seed = name), and name projectBytes() as the project-tile seed-to-bytes rule for other surfaces.

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

## Resume 2026-09-28 (cont'd 9): WS-leak fixed, trailers stripped, merged chat, HEAD 88f9eefd
- **reviewer-2's WS-leak finding, fixed (476f920c):** listen()'s stop()/cleanup() never touched
  `ws` - a stop before the socket reached OPEN (the common case for a quick tap-to-toggle, since
  voiceListening flips true the instant openVoice()'s local setup finishes, independent of the
  socket's own handshake) just walked away from the connection. cleanup() now closes it (moved
  `let ws` up next to the other handles, since cleanup can now run - via the early `if (stopped)`
  return - before the old, later declaration site). Also found+fixed while testing this: stop()'s
  6 s fallback timer was scheduled unconditionally even when cleanup() had already run
  synchronously - real, dangling, harmless-but-slow. New test: a fake socket held CONNECTING
  through two quick taps (reviewer-2's exact scenario). 12/12 (was 11).
- **Credit rule: stripped Claude trailers from the two cherry-picked commits** (capsule-pro's
  originals predated the rule). Rebuilt that stretch via cherry-pick + amend on a temp branch (no
  `-i`), verified trees byte-identical before/after. New shas: a53d0361 (was 1fdccb81), c5b2bd65
  (was baad35a8); everything after got new shas too since history changed underneath -
  work/native-core-composer now points at 476f920c for that stretch, then the merge below.
- Sent the full voice chain to reviewer-2 for logic/state-machine review (the ring/pill CSS
  follows separately once app-design's look lands).
- **Merged work/chat (a25ffff1):** onRecall wired in session.js (b61a506e - opens the hit's
  session via threadHref+go(), landing at hit.ts through the existing ?at= deep link rather than
  a new seq-keyed one), a new `project` opt on mountComposer for @role routing. One composer.js
  JSDoc conflict (both sides added options to the same typedef line), kept both. chat's own timer
  hardening (holdTimer/leaseTimer/fileTimer.unref?.(), 41ed798b) carried forward to every timer
  I've added since (88f9eefd): draft-save debounce, recall-hint debounce, and voice's five
  (press-hold detector, both silence timers, the elapsed-pill interval, the 6 s fallback).
- 110/110 on testbox (composer-*, commands, composer-state, cards, design-components, boundaries,
  local/voice + talk).
- Still open: app-design (ring/pill look), capsule-pro/chat replies not yet in.

## Resume 2026-09-28 (cont'd 10): reviewer-2 sign-off, routed auth chain to reviewer
- **reviewer-2 SIGNED OFF** on 476f920c (WS-leak fix, traced against their exact original
  finding) and c20a0141 (tap-to-talk rebuild, hand-traced "scratch that" undo against 3
  scenarios; confirmed onEscape() puts voice-cancel before the interrupt check). Their testbox:
  88/89 (1 pre-existing skip), 0 fail - matches our 110/110 (narrower glob on their side).
- The other 3 in the chain touch the caller/auth/socket-upgrade boundary, so reviewer-2 routed
  them to "reviewer" per the routing rule, not to me: a53d0361 (caller-allowlist widen), c5b2bd65
  (agent-caller refusal), a81d1f03 (new voice.listen ticket tool). Pinged reviewer for status;
  nothing back yet.
- Pushed work/native-core-composer to origin at 65296734 and told chat it's there.
- **reviewer CLEARED the auth chain**: a53d0361, c5b2bd65, a81d1f03 - patch-identical to
  capsule-pro's already-signed-off 06713585/c9573929/f967b3de (a81d1f03 differs only in
  regenerated docs/index.json); no trailers. Integrator and reviewer-2 already have it.
- **Chain a53d0361..476f920c is CLEAR TO LAND** (all 5 shas reviewed, both reviewers signed off).
- Waiting on team-lead to lock avatar designs before starting the shared seeded avatar renderer.

## Resume 2026-09-28 (cont'd 8): voice rebuilt as tap-to-talk (e21c019d)
User's cutting-edge voice spec, replacing hold-to-talk entirely. Full state machine in
composer.js's "tap-to-talk / push-to-talk" section: voicePressBegin/voicePressEnd (350 ms
tap-vs-hold), openVoice/finishTalk/finishTalkAndSend/cancelTalk, voiceReplace (insert at
voiceStart..voiceEnd, never touching text outside it), the command-diffing in onFinal (see
below), silence timers, the elapsed pill.
- **IMPORTANT protocol fact, easy to get wrong (I did, caught by my own test):**
  local/voice/listen.js's "final" is CUMULATIVE - `committed = committed + " " + text`, resent
  in full on every final, not a delta. "scratch that"/segment tracking must diff against
  voiceCommittedLen (how much of that cumulative string is already box text), never treat each
  final as its own separate insertable chunk.
- Ctrl+M: composer-state.js's KEYMAP (literal "Ctrl+M", the same mechanism Ctrl+O/Ctrl+B already
  use - never "Mod+M", which would be Cmd+M on a Mac and collide with the OS's minimize-window).
  composer.js's key()/keyUp() pair (keyUp is new) handle it both textarea-focused (onKey/
  onkeyup) and globally; session.js needed one added line (a keyup listener mirroring the
  existing keydown one) - smallest possible touch, flagged to chat.
- **Shared test-helper fixes, deck/test/fake-dom.js (real gotchas, not just this feature's):**
  window.addEventListener/removeEventListener (missing entirely - composer.js now calls it at
  every mount for the blur-stops-listening rule) and style.setProperty/removeProperty/
  getPropertyValue (missing too - the --voice-level custom property). Both threw silently deep
  in an event handler, which look EXACTLY like the deck/chat hang (a dangling handle, node --test
  never exits) but are a different, composer.js-specific problem - spent real time chasing the
  wrong lead before finding these. Also added selectionStart/selectionEnd/setSelectionRange
  (missing too), needed for the cursor-insertion test.
- **A second, genuinely separate gotcha:** even with those fixed, a test that stops a session
  without simulating the server's close (ws.close(), matching a real done/error/close) hits
  voice.js's real 6 s fallback-cleanup timer, which is NOT mocked by node:test's mock.timers
  unless mocking was enabled before the session opened (mock.timers only intercepts timers
  scheduled after enable() runs) - dangles the file for a few real seconds, easily mistaken for
  the actual pre-existing deck/chat hang. Every stop in composer-voice.test.js now simulates a
  close.
- composer-voice.test.js rewritten, 11/11. 65/65 across composer-*/commands/composer-state/
  design-components/boundaries. local/voice unaffected, 22/22 + talk 7/7.
- Ran session.test.js (my one-line touch there): 3 pre-existing failures (unrelated - a stale
  rewind-sheet count, a mismatched fixture, an unrelated sight test) plus the file-level hang
  recurred. Sent chat the exact repro (branch, sha, command) since they'd asked to be pinged.
- **Sent for coordination, not yet replied:** app-design (the ring/pill's real Design A look -
  what's shipped is functional placeholder CSS only), chat (whether session-state needs anything
  for "currently dictating", plus the hang repro), capsule-pro (parity - Option+Space stays
  theirs, no conflict with Ctrl+M; offered to share the tap/hold state machine if useful).
- **Not yet sent to reviewer-2** - waiting to hear back from the above before calling it done,
  and still need a screen capture/screenshot sequence for the user per team-lead's ask (once
  app-design's look lands, so it's not the placeholder CSS).

## Resume 2026-09-28 (cont'd 7): voice.listen ticket cherry-picked, verified against the real server
capsule-pro landed the ticket at f967b3de - confirmed my guessed shape exactly, no client code
changes needed (voice.js already called voice.listen and opened `new WebSocket(wsUrl(path))` with
no headers, matching listen.js's issue() -> {path: "/v1/streams/voice/listen?ticket=..."}).
- Cherry-picked their 3-commit chain in order (06713585 open the stream to "deck" -> c9573929
  refuse an agent caller outright -> f967b3de the ticket itself), onto work/native-core-composer:
  1fdccb81, baad35a8, f47bde95. Gotcha: cherry-picking f967b3de alone first (skipping its two
  prerequisites) applied "clean" via `--theirs` conflict resolution but left local/voice/voice.test.js
  failing 1/14 (idle test: "streams: 1" not 0, a leaked stream) - the missing prerequisites, not a
  real bug. Reset and redid the three in dependency order; local/voice/voice.test.js +
  talk.test.js: 22/22 clean.
  docs:ref regenerated twice (28eabbe9) after each cherry-pick's docs/index.json + docs/reference/*
  conflicts (resolved --theirs then regenerated properly, rather than hand-merging generated JSON).
- Full run on testbox: local/voice (22), composer-* + commands + boundaries (30): 51/51 pass (1
  skip, vyre-mic's Swift build, macOS only). Voice is now verified end to end against the real
  server code, not just fakes - ready for reviewer-2.

## Resume 2026-09-28 (cont'd 6): "From your past sessions" hint (fae441ff)
Item 1's composer side, against memory-iq's recall.related (200112a0, signed off by their
reviewer): {session, seq, role, ts, name, title, cwd, snippet, score} per hit, owner surfaces
only, refuses (hits:[]) rather than searching the whole corpus for an unmapped folder.
- Debounced (350 ms) while typing a plain message 12+ chars in a project (opts.cwd()); up to 3
  quiet rows: snippet, "you said"/"you were told" (role user/assistant), ago() relative time
  (deck/js/need-rows.js, shared with Needs). Tap -> opts.onRecall(hit); opening/rendering it is
  the caller's - same pattern as onFind/onFork. Never focuses anything of its own. Dismiss: its
  own close button or Esc (checked before the composer's own escape chain), lasts for the current
  compose - the box going empty resets it. A sequence guard drops a stale answer; wantHint() is
  re-checked before drawing so an in-flight request that outlived its reason to exist (cleared,
  sent, box moved on) never draws.
- **Changed contract:** chat.css gains .composer-hints/-head/-close/-row/-snip/-meta - new
  selectors only, nothing existing touched. Precedent: chat.css already holds every composer-*
  rule (composer-note, composer-chip, composer-images, ...), shared by both teams' composer work.
- composer-recall.test.js (5/5). 44/44 total on testbox (composer-*, commands,
  design-components, boundaries).
- **Needs from chat:** who renders the opened session - session.js's onRecall, same shape as
  onFind/onFork (a `.thread`/`.id`-bearing navigation, not yet agreed or wired). Asked them.

## Resume 2026-09-28 (cont'd 5): reviewer-2 SIGNED OFF a6436f9e/5b602dd0/4711a784/6138a420
Full review of 4711a784 confirmed correct: goal-mode's Enter-intercept ordering (null on the
bootstrap Enter, truthy after, no double-dispatch), "later" correctly absent from commands.test.js's
locking list (no `.local`, same as "vyre" - only local commands force-append), the empty-box
Cmd+Enter-finishes edge case. Reran on testbox at 6138a420: 35/35, matches my numbers exactly.
Only f2dcad85 (voice) is still open, pending capsule-pro's landed voice.listen ticket code.

## Resume 2026-09-28 (cont'd 4): push-to-talk voice built (f2dcad85)
- Blocked briefly on how a browser WS authenticates as caller "deck" (local/voice/listen.js reads
  x-vyre-caller from the upgrade request's headers, which a browser WebSocket cannot set - only
  local/voice/talk.js's Node client can, via the `ws` library's `headers` option). team-lead: the
  answer is term.js's own ticket pattern (authenticated HTTP mints a single-use ticket, the WS
  opens with it already in the path) - capsule-pro is adding it to voice.listen.
- **f2dcad85:** deck/chat/core/voice.js (voiceStatus, listen(handlers), voiceErrorText) + a mic
  button in composer.js (hold to talk, next to attach; no key -> "Add a voice key in Settings" as
  a real link, no stream opened; partial/final replaces what came after whatever was already
  typed; release sends {"type":"end"}; Esc cancels the same way; a race guarded - releasing before
  voice.status/voice.listen resolve stops the session the instant it opens, not the mic left
  running). Web Audio (getUserMedia -> AudioContext at 16000 Hz directly, no manual resampling ->
  a MUTED ScriptProcessorNode graph, gain 0, so the mic never plays back through the speakers) for
  16 kHz mono linear16 PCM, matching capsule-pro's contract with no server-side transcoding.
- composer-voice.test.js (4/4): fakes AudioContext/WebSocket/getUserMedia entirely (this file
  never touches a real mic or socket) to drive the actual composer.js/voice.js code - no key
  blocks correctly, partial/final/done streams text into the box, an error frame ends listening
  and shows its words, Esc sends "end". Gotcha: the fallback 6 s cleanup timer (in case done/
  error/close never arrives) must be tracked and cleared in cleanup(), or every test that calls
  stop() without simulating a close waits out the full 6 s before the process exits - fixed, tests
  run in ~140ms now. 39/39 on testbox (composer-*, commands, design-components, boundaries).
- **Still open:** built and tested against the term.js-pattern shape capsule-pro confirmed
  (voice.status's key/key_state/provider fields, voice.listen -> {path} with the ticket already
  in it), not yet run against their actual landed voice.listen ticket code. Re-verify once it's in.
- Also open: no #voice anchor in Settings yet (links to plain /settings) - capsule-pro/whoever owns
  Settings should let me know the id once that section exists so the link can jump straight there.

## Resume 2026-09-28 (cont'd 3): confirmed, sent to reviewer-2, voice next
- **6138a420** fixed reviewer-2's two findings (diff review, testbox was frozen): .lbl's
  var(--size-meta)/var(--line-meta) had no fallback (deck/onboard/device, deck/person/signin don't
  load tokens.css - device.js draws 4 "Sign in" .lbl's, live not theoretical); /find's local-command
  dispatch checked c.name only, so its "search" alias typed directly ("/search words", not via the
  menu) fell through and got sent as a literal chat message. Both fixed, new test for the alias
  case. reviewer-2 verified by diff, correct on both.
- **Confirmed on testbox once the freeze lifted** (load ~4.5, targeted files, not the full glob -
  see the hang below): composer-drafts/find/goal + commands.test.js + design-components +
  boundaries, 35/35. Sent reviewer-2 all four shas together: a6436f9e, 5b602dd0, 4711a784,
  6138a420.
- **Pre-existing test hang, not mine:** "deck/chat/*.test.js" (the full glob) hangs after
  cards.test.js's plan-card subtests, at ~0% CPU, going nowhere - happened twice today, identically,
  once BEFORE composer-goal.test.js existed. Killed both times (mine, idle). Whoever owns
  cards.test.js/session.test.js/plan-card.test.js should look at it separately from today's freeze.
- **Voice (#2) contract from capsule-pro:** voice.status (key/key_state/provider/mode - key===false
  means show "Add a voice key in Settings"); WS /v1/streams/voice/listen (deck now allowed locally
  only, not over the tailnet - fine, push-to-talk needs the local mic anyway), send 16kHz mono
  PCM16 raw frames + a {"type":"end"} text frame on release, receive listening/partial/final/done/
  error JSON frames. Going with Web Audio (AudioWorklet downsample to 16kHz PCM16) over
  MediaRecorder's webm/opus default, to match their format with no server-side transcoding - told
  capsule-pro, they're open to adjusting chunking once I have something real.
- Next: build the mic button + WS client in composer.js (voice.status check first, partial/final
  text into the composer for editing, never auto-send, Esc cancels).

## Resume 2026-09-28 (cont'd 2): /later + /goal, scope from team-lead
User's final order: 3 and 4 first (the server's superpowers), then 1, 5, 2. team-lead's split:
engine for 3/4 goes to sessions; mine is the palette entries + composer piece.
- **4711a784:** "/later" (static command, example phrasings in the hint, sent as plain text -
  planner.add/parse/agenda/upcoming already exist per my scoping notes below, so no client-side
  time parsing). "/goal <goal>" (new local command): Enter adds the title then a milestone at a
  time, Cmd+Enter or "Set goal" sends one message (title + numbered milestone list), Esc cancels.
  composer-goal.test.js 3/3 - needed a fetch stub (finishGoal sends a real message; without a fake
  fetch a relative-URL fetch never settles and node --test hangs after all assertions already
  passed - see the other gotcha below).
- Next per team-lead: #2 (push-to-talk voice) once /find's full suite is confirmed - reads the
  shared STT provider setting capsule-pro is building (not built yet on my side).
- **Gotcha:** `sendMessage()` (composer.js) hits a real endpoint via attempt()/fetch. A bare
  mountComposer() test with no globalThis.fetch stub doesn't throw - it hangs forever AFTER every
  assertion has already passed, because a relative-URL fetch() in plain Node never settles. Any
  test that reaches submit()/sendMessage (unlike composer-find/drafts, which never do) needs the
  same minimal fetch stub session.test.js already uses.
- **Still queued:** testbox load has stayed 6+ since the freeze announcement (want <4 even for a
  small file) - haven't run /find, /later or /goal on testbox yet, haven't sent /find to
  reviewer-2's confirmation follow-up. Everything is committed; run the moment load clears.

## Resume 2026-09-28 (cont'd): .lbl, /find, testbox frozen for rc.2
- **a6436f9e:** deck.css's base .lbl (mono/uppercase/letter-spaced, ~146 callers) fixed to Design A
  (sentence case, --size-meta/--line-meta, no letter-spacing). Checked in real Chrome
  (deck/test/lbl-shot.js). Found, not fixed: .rail-disclose (chat.css) has its own separate
  uppercase rule ("No project" -> "NO PROJECT" in the rail) - flagged, not mine to touch.
- **5b602dd0:** "/find [words]" composer command (user's cheap-wins list, item 5) - local command
  in commands.js/composer.js, one-line session.js wire to the existing Find page. Both sent to
  reviewer-2.
- Merged chat's work/chat (d2d4628c: budget 8 fixed 106px->4-13px, session.js's Fork wiring using
  `.id` per my correction, caps.js canFork). Re-measured budgets 6/7 on the merged tree: both pass
  (16.7 ms fling, 933.9 ms cold open) - my earlier 67 ms/2,420 ms numbers were stale (my own tree,
  pre-chat's-fixes); struck from the top-5 gap list below as confirmed, not reopened.
- sessions fixed the .id/.thread naming footgun I flagged (d16a345f, work/sessions): threads.start/
  fork/launch answers now carry .thread as an alias of .id; threads.rewind gains .id. Not yet
  merged into this tree - low urgency, my own code already assumed .id.
- **User's final cheap-wins list (team-lead, 2026-09-28):** 1 IQ-inline, 2 push-to-talk voice
  (shared STT provider setting, Capsule + chat), 3 Goals+milestones, 4 /later MAXED (one-off,
  relative, recurring, "when X finishes do Y", runs while the laptop is closed, cancel/edit in
  chat), 5 /find (done above). 6/7 parked for 0.2. Order: 3 and 4 first (the server's
  superpowers), then 1, 5, 2.
  - #3/#4 are planner/sessions/pwa territory (recurring schedules, push/Capsule notifications,
    rendering scheduled items in chat), not composer.js's. Found the planner tool that already
    does most of #4's job: core/planner/index.js's planner.add (kind alarm/timer/reminder/todo/
    note/event, at/in_ms/wall+repeat{every,days,interval,until}), planner.parse (reads "remind me
    to call the printer at 6" into a proposed item), planner.agenda/upcoming (what's coming,
    48h ahead, for a device's own notifications), planner.list (cancel/edit surface). If chat's
    session already has these tools, "/later" barely needs new server code - mostly: (a) make sure
    the tool is available to a chat session, (b) render scheduled/ringing items in the transcript
    (a new block type, chat's/blocks.js), (c) a discoverable "/later" command (mine, trivial, NOT
    built yet pending team-lead's call on ownership). No "goal + milestones" kind exists in
    planner.js yet - #3 needs real new modeling, not just wiring.
  - Sent findings to team-lead, offered the composer-sized "/later" discoverability entry, asked
    whether to wait for chat/sessions to scope #3/#4's actual engine or take a specific piece.
- **Testbox frozen 20 min (team-lead, integrator's rc.2 canonical suite):** no full suites; single
  targeted files under a minute OK if load < 4. A stray full-suite run from before the freeze
  (deck/chat/*.test.js + core/switchboard + core/sessions) hung at test 218 (cards.test.js's plan
  cards) for 9+ minutes at ~0% CPU with load otherwise low - killed it (mine, idle, not
  progressing). Worth someone checking whether session.test.js or a switchboard/sessions test has
  a real hang, separate from the freeze itself, once the tree can run a full suite again.
- Gotcha hit twice this session: `rsync file1 file2 core/sub/file3 dest/` puts ALL sources flat
  into dest/, not at their relative paths - core/commands.js landed at deck/chat/commands.js by
  mistake (caught and removed before it could confuse a test run). Sync files one at a time with
  their own destination path, or use `--relative`.

## Top 5 chat-feel gaps left vs Paseo (2026-09-28, for team-lead)
Read against reference/paseo and this file's own Paseo mapping table + native-bar.md's results.
1. **No draft persistence.** Paseo's input/state.ts saves the unsent composer text every 200 ms;
   ours only remembers SENT messages (up-arrow recall). Switch threads or reload mid-sentence and
   the words are gone. BUILT this session (below).
2. **Full markdown re-parse per frame.** lib/markdown.js's `renderMarkdown` rebuilds a message's
   whole DOM from scratch on every call; Paseo's split-markdown-blocks.ts re-parses only the tail
   block and freezes the rest, so a long streaming reply's already-highlighted code blocks are
   never rebuilt mid-stream. Caller is blocks.js (chat's) - needs coordinating with chat.
3. ~~Budget 6, fling: 67 ms p95~~ STALE - that number was my own tree, before chat's fling fix
   (017c981f). Merged chat's head (cfc98f23) and re-measured: 16.7 ms, passes. Confirmed, not open.
4. ~~Budget 7, cold open: 2,420 ms~~ STALE, same reason. Re-measured on the merged tree: 933.9 ms
   cold / 6.7 ms cache, both pass. Confirmed, not open.
5. **Budget 8's residual jump: 106-134 px while reconnecting, scrolled up** (timing itself now
   passes, well under 1 s, since pwa's fast-reachability fix). Same family as budget 5's now-fixed
   CLS entry (a placeholder box's display flip) - likely another collapse/expand or windowing
   remeasure in session.js/window-view.js, chat's.

Built #1 first (composer.js, no chat-file conflict, quick and testable): a draft store
(`DRAFTS`, module-level, capped at 50 threads like HISTORY's rings) keyed by thread, restored into
a fresh mountComposer() when one exists, saved debounced (200 ms) on every keystroke via
`scheduleDraftSave`, and flushed (immediately, not debounced) by `setValue()` and by `stop()` -
so a fast thread-switch right after typing never loses the last few keystrokes, and any
programmatic setValue (send, prefill, rewind, clear) keeps the store in sync at once rather than
on a delay. Sending clears the thread's draft (setValue("") -> flushDraft() -> clearDraft).
New test file deck/chat/composer-drafts.test.js (3/3): restore across a fresh mount, the
no-debounce-fired-yet case (stop() must flush), and two threads keeping separate drafts. Full
deck/chat suite + boundaries: 95/95 on testbox. Not yet done: #2 needs blocks.js coordination with
chat; #3/#4/#5 are chat's files (window-view.js/session.js) - flagging rather than touching them.

## Resume 2026-09-28 (post-restart, cont'd)
- **6fb2e02a: pickers.js/composer.js side of "Fork from here" done and tested.** rewindSheet
  takes optional `onFork`/`canFork`; without them (an older caller, or chat before it wires
  session.js) the sheet is exactly the three Restore items, unchanged. With `onFork`, a fourth
  radio item "Fork from here" appears (off until `canFork()` says true, defaulting to `can()`);
  picking it and hitting Enter/the go button calls `onFork(p)` only, never `onChoose`. Checked
  threads.fork's actual answer shape in switchboard/index.js: `sb.launch`/`sb.forkAt` both return
  `this.record(id)`, whose id field is `.id`, NOT `.thread` (my last-session note had this wrong -
  correcting the contract I hand to chat below). composer.js needed no change: it only opens the
  sheet via `opts.onRewind()`; the fork wiring lives entirely in pickers.js + whoever instantiates
  rewindSheet (session.js, chat's file). 38/38 targeted (cards.test.js + session.test.js) +
  boundaries 5/5 on testbox.
- **Contract for chat (session.js):** pass `onFork: async p => { const res = await
  CAPS.use("threads.fork", () => attempt("threads.fork", { thread, at: p.uuid, surface }));
  if (res.error) return ...; open the new session the way openHref does, using res.data.id (not
  .thread) as the session id; the original thread's own view is untouched. }` and `canFork: () =>
  CAPS.has("threads.fork")`. Sent to chat with the status-check message; waiting on their reply on
  session.js availability (they were mid the budget-8 reconnect fix) before that side lands.
- **48de0bd3 and 8c0b36ca:** team-lead confirmed budget 9 (8c0b36ca) cleared. 48de0bd3 still
  awaiting reviewer-2's sign-off - pinged them for status.
- Next: once chat confirms session.js is free, or wires onFork themselves, verify end to end in a
  real Chrome run; then back to the parity-gap list (top 5 chat-feel gaps still open) team-lead
  asked for.

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
