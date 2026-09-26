# chat

Branch: work/chat · Worktree: ../vyre-chat · ADR 0024 · Owner session: chat (lead of the chat team)

## Scope

The user, on the Deck: start a new chat from Chat, see the box's folders and open a terminal in
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

## Doing (stopped mid-step at the account switch; each subagent WIP-committed by path)
- session.js: port main's session.js changes (scratchpad patch is gone; regenerate with
  `git diff $(git merge-base 48f8a01 main) main -- deck/chat/session.js`: WINDOW/Show earlier,
  parallel reads, OURS, federation's read-only Mac threads + machine chip, reading the known/turns/
  source/machine opts index.js now passes), the names helper deck/chat/lib/names.js
  (labelFor: assistant name from system.info.assistant.name, else "Vyre"; agents their names;
  user "you"), the ?at=<ms> deep link (scroll + flash; prefer ask anchor), deck-design's card specs
  (vyre.css at work/deck-design 62c7934).
- recall.watch: DONE in 10604b9 (104/106 pass, 0 fail on testbox); shapes sent to capsule-sight.
  session.turn ids are String(recall seq) or "tool:<tool_use_id>"; seq is the transcript line.
- Phone contracts: DONE in 10604b9 (switchboard + gate 69/69). Shapes sent to phone-design, pwa, mobile.
  Rule destination: localSettings (project's .claude/settings.local.json, never committed); chosen
  over projectSettings. gate anchors carry tool_use_id null for MCP calls until harness/mcp forwards
  params._meta["claudecode/toolUseId"] (not ours; unverified on 2.1.283).
- Known red: deck/chat/cards.test.js "tool cards: the checklist, a short diff and a run open on their
  own" fails in the 10604b9 snapshot (session view port was mid-edit). Fix first next session.

## Next
- Diff summary for phone-design's Changes row: permission asks for Edit/MultiEdit/Write get
  detail.changes [{file, added, removed}]; gate.held for a git push gets changes [...] + totals
  {files, added, removed} from `git diff --numstat` of the pushed range. Promised to phone-design.
- STANDING RULE (user): Vyre must not nag; the user runs on bypass permissions. term.unlock needs
  no passkey for the owner (opening a terminal is the person's own action): drop the presence
  requirement for the owner's own surfaces, keep guests/agents/models out. Touch ID only for
  pairing a device, vault secrets, and sending, posting or paying outside; one Touch ID lasts
  about 30 min. Check threads.answer's presence gating against this rule too, and ask the lead.
- Reshoot after the ports (CHAT_DEMO=1 node deck/test/world.js 4791 from a `git archive HEAD`
  snapshot on testbox; deck/test/shoot.js with CHROME=/usr/local/bin/vyre-chrome), including the
  terminal once unlock needs no passkey.
- Folder rows: names truncate ("harlow-si..."); put the path on a second line.
- Merge tailnet's WebSocket upgrade sha when it lands, then shoot the terminal from the Deck.
- Restyle with deck-design once the user picks a direction.

## Needs from others
- deck-design: visual direction for the cards and the terminal; behaviour is built first.
- pwa: owns deck views generally; this team owns deck/chat/** and deck/views/chat.js only.

- box/tailnet (reported to main): the tailnet listener (core/names/service.js) and the loopback
  listener carry no WebSocket upgrades, so the terminal (and Glass) only work on vyred's socket.
- pwa: deck/sw.js SHELL edited by chat in fa2e43e (pwa informed); pwa owns the file.
- tailnet: WebSocket upgrade fix (owned by tailnet, per the lead).

## Changed contracts
- threads.answer: `answers`, decision `always`. threads.asks / ask.raised: `kind`, `questions`,
  `detail`, `always`. New tools recall.transcript, files.dirs, files.recent, term.*. New stream
  /v1/streams/term/pty. New events term.opened, term.closed.
- term.attach and term.open take `surface`; term.unlock (presence) grants 12 h per caller, node and surface.
- recall.transcript / transcripts.blocks: no `from` means the tail; `before`, `first`; turn blocks
  may be `open: true`; user blocks may be `command: true`; tool blocks may carry `patch`.
- files.dirs adds `limit`, `truncated`; files.recent returns an array. files `forward()` passes arrays through.
- system.info adds `assistant: { name }`. deck/sw.js SHELL lists Chat's new modules.
- recall.watch/unwatch, events session.turn and session.state; recall.thread items add id, at; recall.status adds watches.
- threads.asks { kind }; asks add agent, thread_name, anchor { tool_use_id, event }, always_project; request_id hidden. threads.answer scope "project". gate.held adds anchor { tool_use_id, event, thread, at }; gate.request takes tool_use_id. ask.answered adds scope.
- ask.answered adds `answers`. answerLine takes a fifth argument { answers, permissions }.
