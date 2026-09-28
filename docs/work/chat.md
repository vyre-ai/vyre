# chat

Branch: work/chat · Worktree: ../vyre-chat · ADR 0024 · Owner session: chat (lead of the chat team)

## Scope

The user, on the Deck: start a new chat from Chat, see the server's folders and open a terminal in
one, a Claude Code session rendered better than the terminal, replies that read "Vyre" (or the
agent's name), and first-class question and permission cards.

Owns: `deck/chat/**`, `deck/views/chat.js`, `deck/vendor/xterm/`, `core/term/` (new module),
`docs/adr/0024-chat.md`. Small changes through other teams' contracts, listed under "Changed
contracts": `core/switchboard/` (asks), `core/transcripts/` + `core/recall/` (a rich read),
`core/files/` (a folder listing).

## Contracts (fixed before the work is split; every task builds to these)

### 1. Questions and richer permission asks (core/switchboard)

- `translate()`: a `can_use_tool` control request for `AskUserQuestion` becomes an ask with
  `kind: "question"` and `questions: [{ question, header, multiSelect, options: [{ label,
  description, preview? }] }]` (strings redacted and capped: question 1000, label 200,
  description 1000, preview 8000; at most 4 questions, 8 options each). Every other can_use_tool
  is `kind: "permission"` with `detail`: `{ command?, description?, file?, old?, new?, content?,
  url?, input? }` (redacted, each string capped at 8000), and `suggestions`
  (Claude Code's `permission_suggestions`, kept in memory only, like the input).
- `threads_asks` gains `kind TEXT NOT NULL DEFAULT 'permission'` and `detail TEXT` (JSON: the
  questions or the permission detail). `threads.asks` and `threads.get().asks` return
  `{ ..., kind, questions? , detail? , always: boolean }` (`always`: an "always allow" is on offer).
- `ask.raised` payload adds `kind` and, for questions, `questions` without previews
  (`preview` dropped from the event; surfaces read it from `threads.asks`). Events stay small.
- `threads.answer` input adds `answers: { [question]: string }` (multi-select answers are the
  labels joined with ", "; "Other" is the typed text) and a third decision `"always"` (allow,
  with `updatedPermissions` set to the suggestions). An answered question is sent as
  `{ behavior: "allow", updatedInput: { ...input, answers } }`. A question may also be declined
  (`decision: "deny"`). The presence summary names the answers.
- `ask.answered` payload adds `answers` for a question (the chosen labels, capped).
- Fake claude (`core/switchboard/testing/fake-claude.js`): prompt `ask` raises an AskUserQuestion
  (one single-select with previews, one multi-select) and says the answers it got back; prompt
  `demo` runs a rich turn (thinking, Read, Edit, Bash, TodoWrite, text) with permission asks for
  Edit and Bash. When `FAKE_CLAUDE_TRANSCRIPTS` is set, the fake appends real-shaped Claude Code
  transcript lines to `<dir>/<encoded cwd>/<session>.jsonl`.

### 2. A rich read of a session (core/transcripts + core/recall)

- `transcripts.blocks(file, { from = 0, limit = 400 })` returns `{ blocks, next }` where each
  block is one of:
  - `{ seq, kind: "user", ts, text }`
  - `{ seq, kind: "text", ts, message, text }` (assistant text)
  - `{ seq, kind: "thinking", ts, text }` (capped 4000)
  - `{ seq, kind: "tool", ts, id, tool, input, output, error, done_ts, duration_ms }` where
    `input` is the tool input with every string redacted and capped (8000; Write content 8000),
    `output` is the tool_result text redacted and capped at 8000 (null until it arrives), and
    todo lists keep `input.todos` whole (TodoWrite).
  - `{ seq, kind: "turn", ts, duration_ms, tokens: { input, output }, model }` at the end of each
    assistant turn (the last assistant line before the next human line), from timestamps and
    `message.usage`.
  `seq` is the line index in the file, so `next` resumes a live session exactly.
- `recall.transcript { session, from?, limit? }` returns `{ session: {id, cwd, name, title},
  blocks, next }`. Callers: a person's surfaces only (`cli`, `local`, `deck`, `capsule`); tool
  output can hold anything the session read.

### 3. The box's folders (core/files)

- `files.dirs { path?, source?, q? }` returns `{ path, parent, roots, dirs: [{ name, path, mtime,
  git: boolean, project?: slug }] }`: the folders directly inside `path` (default: the roots), or
  folders under the roots whose name matches `q` (bounded walk, 200 max). Every path through the
  files guard; nothing outside the roots, never the vault, Vyre's home or secret folders.
- `files.recent { limit? }` returns recent working folders `[{ path, last, sessions }]` from
  `recall.sessions` cwds and `threads.list` cwds, filtered through the guard.

### 4. A terminal in the browser (core/term, new module)

- `term.open { cwd, cols, rows, surface }`: presence-gated (a passkey the first time a surface
  opens a terminal; a proof is good for that surface for 12 h after). Owner-only callers
  (`cli`, `local`, `deck`, `capsule`; a tailnet guest is refused). `cwd` must pass the files
  guard. Starts a pty (`script` from util-linux on the box, BSD `script` on a Mac; no native
  dependency) running the user's login shell in `cwd`, and returns `{ term, ticket, path }`.
- `term.attach { term }`: a fresh ticket for a live terminal (a reload), same surface only.
- `term.list`, `term.close { term }`.
- WebSocket `/v1/streams/term/pty?ticket=` (one use, 30 s): binary frames are pty output; the
  browser sends text frames `{"t":"in","d":"..."}` and `{"t":"size","cols":n,"rows":n}`.
  When the last socket closes the pty is ended after 10 s unless reattached. Nothing a terminal
  prints is written to the event log. Events: `term.opened { term, cwd }`, `term.closed { term,
  reason }` (no content).

### 5. The Deck (deck/chat)

- Addresses (query parameters, so deck/js/app.js's routes are unchanged): `/chat?new` the new
  session sheet (`&cwd=`, `&project=`), `/chat?folders` the folder browser (`&at=<path>`),
  `/chat?term=<id>` a terminal.
- `deck/chat/term.js` exports `openTerminal(cwd) -> Promise<{term}|{error}>` and
  `mountTerminal(container, { term, onBack }) -> cleanup`.
- `deck/chat/newsession.js` exports `mountNewSession(container, { cwd?, project?, onDone })`.
- `deck/chat/folders.js` exports `mountFolders(container, { at?, onNewSession(cwd), onTerminal(cwd) })`.
- The session view renders `recall.transcript` blocks plus live `thread.*` events; question and
  permission cards read `threads.asks`.
- Labels: the model's replies read the assistant's name (system.info.assistant.name, else "Vyre");
  an agent's thread reads the agent's name; the user's own messages read "you". Never "claude".
- Keyboard: `n` (or Cmd/Ctrl+K then "new") opens New session from anywhere in Chat; in a card,
  arrow keys move, space toggles, Enter answers, 1-9 pick an option, Esc steps back.

## Paseo comparison (27 Sep 2026, user decision: port their session view and terminal)

Source: <reference>/paseo (Apache 2.0, Copyright (c) 2025-present Mohamed Boudra), React Native
(Expo) plus web. Studied: app/src agent-stream, composer, keyboard, file-pane, panels, terminal;
server + protocol streaming.

What theirs does better, by value to the user:
1. Runs of tool calls collapse into one summary row ("3 edits, 2 commands"), expanding to cards;
   on a phone a tool's detail opens in a bottom sheet. Ours is a long stack of cards.
2. A typed tool detail (shell, read, edit, write, search, fetch, sub_agent, plan, unknown) built
   once from Claude's tool input; the client renders by detail type, not tool name.
3. Smooth streaming: committed tail plus a streaming head, 60 ms server coalescing, a paced text
   reveal, so history never reflows.
4. Terminal restore from a screen snapshot (a headless xterm on the server), with a snapshot
   instead of the backlog when a socket backs up. Our 64 KB byte replay garbles full-screen apps.
5. Composer: steer vs interrupt while busy, an editable queue, @file mentions, slash autocomplete,
   Esc interrupts.
6. A bottom-anchor state machine (sticky vs detached) and windowed rendering for long sessions.
7. Diff review with line comments; tool calls open the file at the line.

Where ours is ahead and stays: transcript `seq` is the file's line index, so a view resumes
exactly after a restart (their timeline is in memory, a new epoch per start, every client resets).
Their terminals die with the server; ours will outlive vyred per ADR 0029 R4.

What we keep that they lack: Needs anchors on asks and held items (they pin permission cards in a
footer with no anchor), the Gate (held outbound sends, approve and revise), memory, the assistant
name labels (never "claude"), federated Mac sessions (source "mac", offline chip, "Answer it on
<machine>"), always-in-project, the diff totals on asks, and a terminal that belongs to its screen.

Port plan (shared core in deck/chat/core/: plain ESM with JSDoc types, no DOM, importable by the
Deck as served files and by the Expo app through Metro; mobile to confirm):
- P1 tool detail: port the Claude tool-call detail parser and tool-call display to
  deck/chat/core/tool-detail.js; transcripts.blocks tool blocks gain `detail`.
- P2 grouping: runs of tool blocks as one overview row (core/grouping.js), anchors expand the run.
- P3 streaming and scroll: text reveal, head/tail merge, bottom anchor, windowed rows.
- P4 terminal to ADR 0029 R4: byte offsets and a 1 MB ring, attach from=<offset>, 12 h keep,
  client keeps scrollback and queued keys; headless snapshot when the offset left the ring.
- P5 composer: steer/interrupt/queue, @file and slash autocomplete, Esc interrupts.
- P6 phone: the Expo app renders the same core (mobile owns the RN views).

## Done
- d763ad2 switchboard: question asks, permission detail, always-allow, fake claude `ask`/`demo` + transcripts.
- 4f288d2 recall.transcript + transcripts.blocks (tail by default, `before`/`first` paging, `open` turns).
- 7379d39 core/term + deck/chat/term.js + vendored xterm 6.0.0 / addon-fit 0.11.0.
- ca1fc20 files.dirs, files.recent. a1ebf20 New session sheet, folder browser, entry points.
- a18e934 session view from blocks, raw toggle, question card, permission card.
- 2bdb6f2 sample world: CHAT_DEMO=1 (a finished demo session, live question + permission asks),
  alex's folders beside the Vyre home (the guard hides the home), WebSocket proxy.
- a8ca577 ADR 0024, CHANGELOG.
- 41941b9 recall.transcript reads unindexed sessions (code not_found when no file).
- 3e3e843 session view layout fixes (cards keep height, todo/bash/edit open by default, live fallback, chips).
- 45557bf system.info.assistant.name (the label source; null means "Vyre").
- 4ef2339 merged main (kept work/chat's index.js and session.js; main's changes ported after).
- fa2e43e index.js port of pwa's speed work and federation Mac rows; keys only while ctx.shown();
  deck/sw.js SHELL gains Chat's new modules (pwa's file, told pwa).
- 7e21ed1 terminal "needs the box link" state (deck/chat/lib/term-link.js).
- 8794777 the seeded demo session releases its lease.
- Composer hint no longer says "Claude Code's commands" (f857520).
- Slice 1 screenshots: <team-dir>/chat-shots/ (reported to main).
- 1ec063b Mac sessions have a composer (threads.send with machine, offline chip, "Answer it on <machine>"); fakes only.
- f0d60b3 merged main d3ed622.
- 2f2b1ff no nagging: threads.answer off HUMAN_ONLY onto core/presence PERSON_ONLY (no proof; the
  harness still refuses a model's shell naming it, with term.open/term.attach); term.unlock gone,
  a terminal belongs to the screen that opened it (attach elsewhere: not_found); Deck answers and
  terminals ask no passkey. Diff summary: Edit/MultiEdit/Write/git push permission asks carry
  detail.changes [{file, added, removed, binary?}] + detail.totals {files, added, removed}
  (+ truncated at 200 rows), core/switchboard/changes.js; a push ask is raised after git (3 s
  budget). sw.js SHELL adds chat/term.js, term.css, lib/term-link.js (tell pwa).
  Tests on testbox: term, presence, floor, harness, switchboard, changes, switchboard-cli,
  capsule bridge, deck/chat, deck/test, guests, hygiene: 247/247 after one test fix.
- composer.js "Claude Code's commands" was already fixed (f857520); only a code comment remains.

## Done (28 Sep)
- Project chip (finding 6): session.js's header now shows which project a thread is in
  (`projectName()`, from `record.current.project` - the only source for an agent's own thread,
  falling back to the route's slug - name-mapped via `opts.projects`, else the slug itself).
  index.js passes `projects: state.projects` and `project: project || known?.project`. New
  `.tag.cv-project` in chat.css. The session-list rows already showed this (index.js's
  `threadRow`'s `where`, unchanged). Test: session.test.js's kit/NEW thread now carries `project`
  in its threads.get fixture and asserts the chip text. testbox: deck/chat + deck/test 480/481 (1
  skip, pre-existing), 0 fail; session.test.js 16/16. Sent to reviewer-2 (no auth/presence touched).
  SIGNED OFF by reviewer-2 (306/306 on deck/chat's own suite, targeted). Pushed work/chat for the
  integrator: 378c7f54.

## Done (28 Sep, review fixes: d9d1cafb)
- reviewer's 2 LOWs on 9fd902ac: strict base64 check on image data (BASE64_RE) before it goes
  anywhere; a whole read's pictures now share one RESPONSE_BYTES_CAP (12 MB, Reader.imageBudget),
  spent across every block so a many-block page (or a relayed Mac read) can't become hundreds of MB.
- the lead's $ rule: the turn footer's cost figure only draws when auth is really "api-key"
  (session.js asBlock passes S.auth through; lib/blocks.js turnParts gates on it) - a subscription
  session never shows a dollar amount.
- testbox: deck/chat+deck/test+transcripts+switchboard 604/605 (1 pre-existing skip), 0 fail.

## Done (28 Sep, perf pass)
- Fling p95 (native-bar budget 6): window-view.js's update() measured every mounted row's box
  twice per scroll frame (once before mount(), once after); when mount() didn't run (a plain
  scroll within the same window range - the common case), the second measure re-read the exact
  same boxes for nothing (017c981f). testbox native-bar: budget 6 now 16.7 ms p95, pass (was the
  open item since the earlier profile: "2.2 s in getBoundingClientRect"); budget 7 (cold open)
  928.8 ms, already under its 1000 ms budget - not this fix, looks like other work since landed.
  window.test.js + core/window.test.js + session.test.js: 37/37.

## Done (28 Sep, cohesion item 18: inline pictures)
- core/transcripts (9fd902ac, made in sessions' place per the lead - they were paused): `images:
  [{media_type, data}]` on a user or tool block, capped (2 MB/image, 4/block, 6 MB/block total).
  Sent to reviewer; noted in docs/work/sessions.md.
- chat's own half (62b254f4): core/images.js (DOM-free caps/shaping, shared with pwa/mobile),
  lightbox.js (one overlay, tap-to-zoom, Esc/backdrop close, focus returns to the opener),
  blocks.js renders real thumbnails (userRow and toolCard) instead of a bare "N images" count,
  composer.js's local echo carries the actual pictures so a just-sent message looks right at once,
  session-state.js never lets a server confirmation's bare count downgrade a richer local array.
  Every thumbnail is a fixed box before it decodes (interaction.md section 1: never a layout jump).
  Sent to reviewer-2. testbox: deck/chat+deck/test+transcripts+switchboard 602/603 (1 pre-existing
  skip), 0 fail; boundaries+docs-check 66/66.
- Open for later: sight.frame stills at a running step (needs a target-per-thread lookup, not yet
  built); rate-limiting sight.frame across chat and Glass's own caller (cohesion's item).

## Done (28 Sep, sight.frame stills - cohesion item 1/18)
- A small "cv-sight" strip in session.js's header area, drawn once per mount when this thread's
  own agent (record.current.agent) has a live target in sight.targets (the registry - never a
  guessed "agent:<name>"; a plain session or an agent with no computer running draws nothing).
  Calls sight.frame for the first still, refreshes on sight.stepped scoped to this thread AND this
  exact target (never another agent's, even a live one). Reuses blocks.js's pictureThumb (now
  exported, takes an optional size) and core/images.js's frameToPicture (built ahead of time, with
  the pasted-image work). New CSS .cv-sight in chat.css.
  Tests: two new session.test.js cases (kit's own target draws and refreshes correctly and only
  for its own thread/target; no agent or no live target draws nothing). testbox: deck/chat+deck/test
  494/495 (1 pre-existing skip), 0 fail.
- Not done: no historical replay (sight.frame only ever answers the LATEST still - there is no way
  to ask for what a past step looked like, so this is a live-only "what's happening now" strip, not
  part of the transcript's history). Rate-limiting sight.frame across chat's own caller and Glass's
  (cohesion's open item) is still open - not addressed here.

## RESTART (28 Sep, usage-prep save point, head 9e2c54bc)
Status for whoever resumes: sight.frame stills (item 1/18) is DONE and pushed (18980d2d), sent to
reviewer, not yet signed off - check for a reply first. Budget 8 (below) is the one open item,
PARTIAL only - the redundant-layout fix landed (9e2c54bc, sent to reviewer-2) but the scroll jump
itself is still unfixed; waiting on the lead's steer (asked: add temp instrumentation to
window-view.js, or a live repro). After budget 8 is closed: native-core's "Fork from here" (they're
building pickers.js/composer.js; asked me to hold session.js until they hand me the exact
threads.fork {thread, at} contract - I told them to hold too, given budget 8 was in progress).
Nothing uncommitted; no testbox processes running.

## Doing (28 Sep, budget 8: reconnect scroll jump - PARTIAL)
- native-bar budget 8, before: 1086.7 ms (fail, over the 1 s budget), anchor moved 80 px / scrollTop
  changed 52 px, first moving 1149 ms after the network came back - BEFORE thread.finished (1313 ms),
  i.e. during the reconnect catch-up itself (reread()'s event replay + refresh()'s transcript
  re-read), not triggered by thread.finished landing as first suspected.
- Found refresh() called patch(applyBlocks(...)) (which already calls layout() itself whenever any
  changed key needs it) and THEN called layout() again unconditionally right after - a redundant
  second anchor-capture-and-restore on rows already correctly measured. Removed the redundant call
  (kept grew(), which still covers the one case patch() skips: a batch of text-only deltas).
- Result: catch-up time 1086.7 ms -> 900 ms, now UNDER the 1 s budget. But the scroll jump itself
  is UNCHANGED (still 80 px / 52 px, identical to the number before this fix) - so the redundant
  layout() was real waste, but not the jump's cause. testbox: deck/chat+deck/test 494/495 (1
  pre-existing skip), 0 fail; native-bar budget 8 re-run confirms the time number, jump still fails.
- Next: the jump happens while scrolled up 300px, WHILE all new content lands at the tail (below
  the reader) - it should not move the anchor at all unless window-view's own windowed-mount range
  shifts and brings a previously-unmounted (estimated) row into the mounted set for the first time
  during this exact sequence, revealing its real height late. Needs either temporary instrumentation
  in window-view.js (log heights.get() vs the real measured height per key during this exact
  scenario) or a live repro in a real browser - reported to the lead rather than guessing further
  blind.

## Doing (28 Sep, restart after cohesion's hand-over)

- Merged origin/main clean (4032bf03; no conflicts). ADR 0038 (server, not box): renamed the
  user-facing "box" strings in files chat/core-term own (composer.js, term.js, folders.js,
  index.js, newsession.js, pickers.js, core/term/index.js + core/term/term.test.js incl. the
  term.closed reason "box updated" -> "server updated"); left `ctx.config.role === "box"` (the
  stored config value, out of scope per the ADR) and every other team's files alone. node --check
  clean on every touched file; a real testbox run is next once the lead clears the box (rebooting).
- Cohesion's hand-over (docs/design/interaction.md, one-product-audit finding 6): read
  newsession.js and session.js end to end. A plain session already opens in the right project
  (context.now's nowProject feeds state.where, newsession.js:113-114). An agent/teammate session
  (agents.ask via startCall) never sends `project` at all - by design, an agent "works in its own
  thread and its own projects" - and session.js's header (drawHead) shows only the agent name and
  folder path, no project chip anywhere. So there is no visible sign of which project a teammate's
  thread landed in once it opens - confirmed, not yet fixed. Reported to the lead, asked to build
  once testbox is clear rather than land a header change untested.
- Next once the lead clears testbox: `node --test "deck/chat/**/*.test.js" "core/term/**/*.test.js"`
  to confirm the terminology rename broke nothing, then build the project chip in session.js's
  drawHead (record.current.project, name from projects.list when loaded else the slug).

## Doing (27 Sep, late; saved for restart)
- Handed off: integrator has 0b6f9091 (batch 5 / RC). Nothing uncommitted. Resume: merge main, then perf
  (fling, cold open) when testbox load < 2, then cohesion 5 when cohesion says P1 + Render are on main.
- Batch 4 landed (main bc751624, notes 68463d04), merged into work/chat; next sha 0b6f9091 (pushed):
  plan card, tips line, cohesion 1 and 9, raw relative paths, send-to-row, shots on vyre-chrome
  --headless=new. Tests: 598/598 targeted (1 skipped) after the merge. Shots: team/chat-shots/2026-09-27/after/.
- The integrator's d49d535e: chat.css/term.css use the 719 phone query (dom.js PHONE_QUERY) and radius
  roles (--r-* is gone); answers go through pwa's queued() outbox. New chat CSS must follow both.
- Waiting: perf timing (fling, cold open) until testbox load < 2; cohesion 5 (platform P1 382a8574
  and the Render shape on main, cohesion says when).

## Before (27 Sep, evening)
- UNTESTED (testbox held by the lead until batch 4 reports): 00b7a269 plan card (deck/chat/plan-card.js,
  core/plan.js parser, fake claude `plan`, world's third live session, chat-shots 8-plan, switchboard
  test), 942047c2 cohesion 1 (context.report on open, context.now project default), a3e31c67 tips
  on the composer hint line (tip-line.js; composer.js tipSlot/input, sw.js SHELL adds three files),
  de2c8adc cohesion 9 (nav refresh on thread.status, agents.changed). FIRST when testbox frees:
  `node --test "deck/chat/**/*.test.js" "deck/test/*.test.js" "core/switchboard/**/*.test.js"`,
  then chat-shots --only plan and a desk/phone look at the tip, then send the integrator the tip sha.
- Cohesion 5 (the / menu merges commands.list, Render cards) waits on platform P1's sha from cohesion.
- Plan card deviation: Revise writes in the card (not the composer, native-core's). Needs row "kit has
  a plan to approve" is pwa's deck/js/needs.js. Docs base for tip Show me: https://docs.vyre.run/ (ask docs).
- Perf: fixed, see "Done (28 Sep, perf pass)" above.

## Earlier (27 Sep, after logout 4)
- Done this session: 19c287db merge main 7880dfa6; 553017a1 scroll jump (content-visibility
  placeholder collapsed the just-finished reply; native-bar budget 5 now 0 px, CLS 0; phone keyboard
  lift read an undefined `following`); 0293db20 question card never cut off + ask/question cards to
  Design A v1 (A/D, busy verbs, outline Always, kbd chips) + deck/test/chat-shots.js; f697d345
  terminal fills the view, key bar 2x7, spec look; 5d91f833 refuse queuing images (composer-state
  enterAction do "refuse"); 93945c49 diff/status marks/checkbox/avatar to spec; dbeac450 relative
  paths, tool rows as verbs (waiting on you, failed, no "done"), no footer on an open turn, phone
  header two rows, folds on the phone, steer marker copy. deck/chat tests 285/285 on testbox.
- model.switched: listened (session.js on("model.switched"), session-state case, test in
  session-state.test.js and session.test.js).
- Shots: `ssh testbox 'cd ~/vyre-ci/chat && flock ~/vyre-ci/chat.lock node deck/test/chat-shots.js <out>'`
  (every chat testbox run goes through flock ~/vyre-ci/chat.lock).
- Open from the 13: #5 phone composer and #6 queued row are native-core's. Spaces collapse in
  Instrument Sans in headless Chrome on the phone shots ("Nooneis typing"): not chat CSS, report to
  pwa/app-design. Raw view still prints absolute paths (Claude Code prints relative ones).
- Perf: send-to-row fixed (ba8ffb45, 16 ms). Fling: the profile (Profiler during budget 6) had 2.2 s in
  getBoundingClientRect (two forced layouts per scroll frame in window-view update), 350 ms clock(),
  290 ms icon parsing; the last two are cached. A "quick" scroll pass (skip the post-mount measure)
  measured worse (66 ms) under testbox load 10, so it was reverted; re-measure when load < 8.
  Cold open 1.1 s (budget 1 s) not looked at yet.
- Next (lead): with native-core, fling p95 and cold open. Then, once
  the lead OKs new work: cohesion items 1, 5, 9 (context.report on open, / merges commands.list, one
  nav catalog); docs tips.next chip; plan card (spec, not built).

## Before logout 4
- Chat smoothness (27 Sep, all five committed, untested: testbox held, node --check only): 1 reconnect
  (api.js stream.reset + CLOSED retry + onResume, session re-read on resume; api.js change to tell pwa),
  2 stick to bottom (window-view.js createStick, ResizeObserver), 3 frozen live-text blocks + linear
  settledEnd + highlight on close, 4 paced reveal (Paseo text-reveal), 5 incremental grouping.
  Next: run deck/chat tests on testbox (api-stream, live-text, grouping, pace, session, window new/changed).
New direction: ADR 0030 (Agent SDK sessions are the default) and Direction A (docs/design/one-app on
work/app-design, Session board). Chat is a native chat over Vyre's event stream; the terminal stays.
- Take size back in the Deck terminal (27 Sep) against resilience's core/term size owner (ab4fdc4d).
- Done this session: fb22bad (pre-logout WIP committed), 231221b merged main ef51363, 7f49979 diff
  summary on the permission card (changesRow, exported for pwa's needs.js), b20fec2 live text keys
  (message, block) equal the transcript's (verified against one real Claude Code 2.1.268 run on
  testbox; user blocks carry uuid), f2c5b62 core tests + 2 bug fixes (tool-detail Task threw,
  line-diff dropped "-- x" lines), 7fa868e deck/chat/core/session-state.js, pace.js, grouping.js.
  Tests: core 45/45, transcripts+switchboard 98/98, deck/chat 87/87 (testbox).
- Event shapes proposed to sessions (27 Sep): thread.text block, thread.tool call/status,
  thread.turn uuid = SDK message uuid = transcript uuid, thread.queued uuid, thread.unqueued,
  thread.state, thread.usage, thread.started provider/model/auth, finished canceled. Tools asked:
  threads.unqueue, threads.edit, threads.send {now}, threads.interrupt. Awaiting reply.
- Done (27 Sep): cbe3a66 session view rendered from session-state + grouping + pace (live-text.js),
  fold rows, count-up, thinking length, provider chip, state word, idle "Resumes on your next
  message", Stop (Esc: threads.interrupt, else threads.stop), queued rows (buttons disabled: no
  threads.edit / threads.unqueue / threads.send {now} on any branch yet), inline asks with A/D,
  "Answered from <surface> · <time>". Behaviour changed on purpose: tool runs fold (session.test.js
  "open" test opens them first); the composer's own queue line is gone (rows replace it); a failed
  turn reads "Turn failed: ..." in its footer. Tests: deck/chat + deck/test 221/221 (1 skipped) on testbox.
- Aligned to the final sessions contract (27 Sep, untested: testbox held): queue by row id
  (unqueue/edit/send_now), step counted client-side, rewind forks and opens the fork, Shift+Tab
  over three modes, threads.start busy note, NOT_OFFERED tools off from the start in caps.js.
- Gaps for sessions: threads.interrupt is on work/sessions only (the Deck falls back);
  threads.edit, threads.unqueue, threads.send {now} are nowhere; thread.queued needs `uuid` for rows
  to act on; ask.answered `by` is a surface, not a device ("alex's iPhone" needs a device name).
- Mac asks answered from the Deck (federation v2, untested: testbox held): buttons + "on <mac>", threads.answer carries `machine`; person_session_required / presence_required reuse api.js's passkey proof, mac_offline / timeout retry; no box flag exists, so an unknown/unsupported refusal (or "no ask" on an unrelayed ask) falls back to "Answer it on <mac>" for the page.

## Composer like Claude Code (27 Sep, TESTBOX FREEZE: tests written, not run)
- deck/chat/core/composer-state.js (draft mode by first character, @ at the caret, history ring,
  Enter decision, Esc machine, Shift+Tab over offered modes, KEYMAP, image caps), core/caps.js
  (lazy "no such tool" probe, one per page), commands.js normalizeCommands + local /model /rewind.
- session-state: localSend/dropLocal (optimistic steer and queue), thread.steered (marker
  steer:<uuid> moved to where it joined), thread.rewound (drops from that message on; dropped
  idents never read back), thread.mode/model/thinking/task, s.todos (newest TodoWrite), s.tasks
  (derived from Bash run_in_background / KillShell / BashOutput / Task until thread.task),
  localShell rows, checkpoints().
- Deck: composer.js rewritten (pickers.js, tray.js), session.js wiring, chat.css.
- core/transcripts: steered user blocks.
- Live now: steer/queue drawing (threads.send accepts extra fields today), history, Esc stop,
  todos pin, derived tasks tray (View output), thinking view toggle, @files via files.search,
  static commands. Waiting on sessions: thread.steered, threads.unqueue/edit/steer, rewind +
  checkpoints, mode, model, sessions.models, commands, shell, remember, thinking, thread.task,
  kill_task, images on threads.send (a send answer without `uuid` is read as an older box).
- Tell pwa: deck/sw.js SHELL needs /chat/pickers.js, /chat/tray.js, /chat/core/composer-state.js,
  /chat/core/caps.js, /chat/core/commands.js, /chat/core/match.js (the last two were missing already).

## Next
- thread.limit as a line in the turn (the design's limit fallback); windowed rows above 100 items;
  an inline ask anchored to its tool row once ask.raised carries tool_use_id.
- Screenshots in one world on port 4795 (load rule), time Back (< 100 ms).
- Mounted tabs (LRU) with pwa. Real WebKit run for 60 fps / 300 MB; if iOS momentum stutters, invert the scroller.
- Design look at the key bar and Take size (app-design).
- ask.raised should carry tool_use_id so an inline ask anchors to its tool row (ask sessions/switchboard).
- deck/chat/lib/diff.js may share line-diff's "-- x" header bug: check.
- Folder rows: path on a second line.
- Test command on testbox: node 22 needs globs, `node --test "deck/chat/**/*.test.js"`, not a folder.

## Needs from others
- deck-design: visual direction for the cards and the terminal; behaviour is built first.
- pwa: owns deck views generally; this team owns `deck/chat/**` and `deck/views/chat.js` only.

- box/tailnet (reported to main): the tailnet listener (core/names/service.js) and the loopback
  listener carry no WebSocket upgrades, so the terminal (and Glass) only work on vyred's socket.
- pwa: deck/sw.js SHELL edited by chat in fa2e43e (pwa informed); pwa owns the file.
- tailnet: WebSocket upgrade fix (owned by tailnet, per the lead).

## Changed contracts
- deck/js/icons.js icon() parses once per name and size and clones; deck/js/fmt.js clock() keeps one
  Intl.DateTimeFormat (pwa's files; the fling profile showed 290 ms parsing icons, 350 ms in clock()).
- deck/test/pwa.test.js (pwa's): two pins follow chat's changes: the keyboard lift reads stick.stuck, and
  transcript rows carry no content-visibility (windowed instead).
- threads.answer: `answers`, decision `always`. threads.asks / ask.raised: `kind`, `questions`,
  `detail`, `always`. New tools recall.transcript, files.dirs, files.recent, term.*. New stream
  /v1/streams/term/pty. New events term.opened, term.closed.
- term.attach and term.open take `surface`; term.unlock removed (no presence); attach from another screen is not_found.
- core/presence: threads.answer moved from HUMAN_ONLY to new PERSON_ONLY (with term.open, term.attach); core/harness/rules.js refuses both lists to a model's shell.
- threads.asks detail adds changes, totals, truncated for Edit/MultiEdit/Write and git push asks. deck/js/needs.js (pwa's) answers without a passkey.
- recall.transcript / transcripts.blocks: no `from` means the tail; `before`, `first`; turn blocks
  may be `open: true`; user blocks may be `command: true`; tool blocks may carry `patch`.
- files.dirs adds `limit`, `truncated`; files.recent returns an array. files `forward()` passes arrays through.
- system.info adds `assistant: { name }`. deck/sw.js SHELL lists Chat's new modules.
- recall.watch/unwatch, events session.turn and session.state; recall.thread items add id, at; recall.status adds watches.
- threads.asks { kind }; asks add agent, thread_name, anchor { tool_use_id, event }, always_project; request_id hidden. threads.answer scope "project". gate.held adds anchor { tool_use_id, event, thread, at }; gate.request takes tool_use_id. ask.answered adds scope.
- ask.answered adds `answers`. answerLine takes a fifth argument { answers, permissions }.
- transcripts.blocks / recall.transcript: a user block inside an open turn has `steered: true, step: n` and does not close the turn.
