# chat

## 0.3 (chat teammate, 3 Oct 2026): world-class chat on every device

Branch work/chat-03 (work/chat is the 0.2 chat branch, kept untouched) · Worktree ../vyre-chat-03 · ADR 0052 (claimed) · Spec: team/0.3/DESIGN-chat.md
Base: main + origin/work/kernel (kernel/contracts) + origin/work/ui (@vyre/ui at apps/app/ui). Contracts files taken from work/kernel.

### Scope
1. The stream: one typed, resumable session stream (core/stream).
2. Steer, stop, edit and retry, branch; the composer never disables.
3. The terminal on every device (core/term attach; desktop pane, phone full screen with accessory row; typed commands recorded in the session).
4. Chat screen + composer in apps/app on @vyre/ui; native result components; inline approvals.
5. Performance, measured: first token <= 300 ms from emit, resume <= 1 s, 60 fps on a 10,000-message thread.

### Design (fixed before the work is split)
**Stream frame.** Every frame is a projection of the kernel EventEnvelope (kernel/contracts/event.d.ts): `{ v:1, id (uuid), cur (int, per-session, gapless from 1, the cursor), session, turn, type, time, corr (turn id), data }`.
`type` is `session.<kind>` ("noun.past-verb" is for log events; a stream frame is not hash-chained, deltas are too frequent for the log; `toEnvelope(frame, ctx)` lifts any frame into a real envelope when it must be logged, e.g. tool.finished, ask, file-change, terminal.command). Kinds and `data`:
- `text-delta` { message, index, text } and `text-done` { message }
- `tool-started` { tool_id, tool, kind, summary }, `tool-progress` { tool_id, text? , pct? }, `tool-finished` { tool_id, ok, result: Block }
- `term-chunk` { term, offset, b64 } (byte offsets from core/term/ring.js; offsets make terminal resume exact)
- `term-command` { term, command } (what the person typed; recorded in the session, the assistant sees it)
- `file-changed` { path, op: create|edit|delete, diff? }
- `ask` { ask_id, kind: permission|question|approval, task? , ... } and `ask-answered`
- `user-message` { message, text, state: sent|queued|picked-up, queued_at? }
- `status` { state: starting|working|asking|waiting|paused|stopped|finished|failed, turn?, stopping? }
- `reset` { reason }: the cursor is older than the log holds; the client reads a snapshot, then resumes from `snapshot.cur`.
**Block** (what a tool result becomes; never raw JSON): `{ block: "terminal"|"diff"|"files"|"record"|"task"|"draft"|"flow-change"|"answer"|"screen"|"text", ...props }`. Unknown tools degrade to `text` (a short summary), never a JSON dump.
**Resume.** A client holds `cur`. Subscribe(from=cur) replays frames cur+1.. in order, then goes live with no gap and no repeat (the server replays and joins the live fan-out in one tick; the client drops any `cur <= last`). Over the direct connection and over the relay it is the same call: the transport is a duplex of JSON frames; the relay forwards bytes. A frame is never required to be acked; the client's `last` is the only state.
**Steer.** A message sent while working is `user-message{state:queued}`, then `picked-up` at the next safe point (between tool calls or turns, never mid-tool). Never disabled, never lost on a stop or restart.
**Not doing:** a second stream per device, per-provider frame shapes, client-side ack/retransmit protocol, polling faster than 60 s, JSON dumps in the UI.

### Done
Worktree made, kernel and ui merged (d16c0fee4).
- Task A (core/stream), 3 Oct: protocol.js, log.js, server.js (serve + SSE + WS), client.js (resumable, Node/browser/RN), adapter.js, index.js + module.json (tool `stream.open`, stream `session` at /v1/streams/stream/session), index.d.ts. Tests: protocol, log, server, client, adapter, stream (module in a real Registry), kill (200 + 200 + 100 lossy, seeded, virtual time), perf. See the numbers under "Task A numbers" once the testbox run is in.
- Changed contracts: none. Merged history frames carry optional `span` + `data.parts` (a stored-history merge; live frames never do). Control frames `reset` and `heartbeat` have cur 0 and are not logged. Route is /v1/streams/stream/session (module `stream`, stream `session`), not /v1/streams/session.
- Not mapped on purpose: thread.usage, thread.limit, mode/model events. (thread.unqueued is now `user-message{state:cancelled}`, task E.)
- Not done by A: a snapshot builder (client.snapshot() is the caller's: read the session state, then resume from its cur; stream.open returns head and floor to anchor it), docs pages for stream.* config keys, CHANGELOG entry, docs/reference regenerated but not committed (other teams' hunks are in those files).

### Done: task B (steer, stop, edit-retry, branch; core/switchboard)
- queue-state.js + tests; chat-steer.test.js (9 end-to-end tests with the fake claude: steer, stop, restart mid-queue, edit/unqueue, edit-retry, retry, branch, unsupported).
- threads.edit-retry {thread, text, message?, restore?}, threads.retry {thread, message?, restore?}, threads.branch {thread, at?, prompt?}: reach person, registered in core/switchboard/module.json; docs:ref regenerated.
- Changed contracts (core/switchboard, smallest possible): (1) events thread.queued / thread.sent{via:steer} / thread.steered gain queued_at and step (steered also text); thread.sent via turn and restored gain queued_at. (2) restoreSteers and a turn's end now emit thread.steered for steers they run as a turn (they stayed "queued" forever on a surface). (3) a resume hands over words left in the queue by a stop or restart (resumeQueued, same path as a turn's end), so a queued message is never stranded. (4) threads.stop emits thread.status {status: <current>, stopping: true} before closing; no new status word (lib/thread-status unchanged). (5) write() also returns `at`. (6) index.js imports lib/caps-flags for the unsupported check.
- Not done here: the composer draft is client state (apps/app, task D); the server holds no draft and stop never touches one. Stop keeps its meaning (closes the process; threads.interrupt is Escape).

### Done: task C (the terminal on every device)
Server (core/term): `term.open` takes `session` (cwd optional: with a session and no cwd the shell opens in `threads.get {thread}.cwd`, through the files guard); the term record keeps `session`, `term.list`, `term.opened` and terms.json carry it. core/term/typed.js assembles typed lines from the `{"t":"in"}` frames (printable, paste, Backspace, Ctrl-U/W, Ctrl-C/D; history, tab, cursor keys and Ctrl-R mark a line unknown and it is not reported). A completed line becomes event `term.command {term, session, command}` (thread = session; redacted by core/transcripts/sanitize.js, capped 2000) and goes to every `onCommand(cb)` subscriber (named export of core/term/index.js; cb gets `{session, term, command, at}`; task A's stream adapter lifts it to `term-command`). Secrets: not recorded when the line began at a prompt that asks for a password/passphrase/passcode, or when the tty's echo flag was off at its first key (`stty -a`, plain pty; dtach has no tty path yet so only the prompt rule applies there). Output is still never logged.
- Tests (testbox, plain pty): core/term/typed.test.js 6, core/term/term-session.test.js 5 (open for a session, command recorded + redacted, no session records nothing, password prompt by prompt text and by echo flag, kill the socket mid-`seq 1 40000` then term.attach from=<bytes held> gives exactly the missing bytes: joined == a fresh full replay, byte for byte). 11/11 pass; core/term/term.test.js still green (as before).
- Client (apps/app/src/terminal): ONE implementation on every device. `public/term/frame.html` (made by scripts/term-assets.mjs from the Deck's vendored xterm + client.js + keys.js + frame.js) is an iframe on web and a react-native-webview on phones; the RN side (Terminal, TerminalPane, TerminalScreen, AccessoryRow, chrome) speaks to it with postMessage. Why not the npm xterm on web plus a webview on native: two renderers to keep equal, a new dep, and the Deck's xterm is already proven; the cost is the native path loads the page from the box origin (`frameUrl`), which the session screen must pass.
- `client.js` TermClient: byte offsets, `at` adoption, `cut` handling, reconnect from the last offset (250 ms to 8 s), keys held 4 KB while away, size, take. Local until core/stream's resumable client lands (different frames; term socket is binary + {t}).
- `keys.js` pure: esc, tab, sticky ctrl, arrows (SS3 in application-cursor mode), pipe, slash, ctrl+<c>. 13 node tests (client 7, keys 6) pass.
- Phone: TerminalScreen (full screen, accessory row above the keyboard, back button + left-edge swipe). Desktop: TerminalPane (resizable by its left edge). Pinch resizes text (frame.js), copy/paste buttons (copy falls back to the screen text when nothing is selected, touch has no selection), Ctrl+Shift+C/V on desktop. A key typed on a screen that does not own the size takes it (`take`).
- Proof: apps/app/app/terminal-demo.tsx + scripts/fake-term.mjs (fake term socket, core/computers/ws.js), exported on testbox and shot: docs/work/shots/chat/terminal-390.png, terminal-1280.png (+ -paper).
- Changed contracts: (1) core/term `term.open` input: `cwd` no longer required, `session` added; returns `session`. (2) `term.list` rows, `term.opened` payload and terms.json rows gain `session`. (3) module.json emits `term.command`; `onCommand` is a new named export. (4) core/term/index.js now imports core/transcripts/sanitize.js (redaction). Docs: `npm run docs:ref` is stale for the whole tree (other teams' tools/events too); regenerate at integration.
- apps/app/package.json: + react-native-webview 13.15.0 (native terminal page); package-lock regenerated on testbox (the committed lock was already missing the @dnd-kit/@rn-primitives deps); export:web runs term-assets first.
- Not verified: the native WebView path (no device/simulator); `threads.get` lookup of a session's cwd by `module:term` (no switchboard in the term test registry; if its guard refuses the caller, pass cwd); dtach (testbox has none) for the same flows.

### Done: task D (chat screen, composer, native blocks, performance; apps/app/src/chat)
- Blocks.tsx: TerminalBlock (live ANSI, collapse, copy, open full terminal), DiffBlock (unified on phone, side by side on desktop, file tree above 3 files, open in Drive), RecordCard (sealed fields only as the typed chip, class + present, never a value or ref; blocks.js drops them at the door), TaskCard (inline approval, `onFaceId` callback, no modal), DraftBlock (editable), FlowChange, CitedAnswer, ScreenFrames (take over), TextBlock; one `renderBlock(block, ctx)` over the Block contract; unknown or malformed results become short text, never JSON.
- frames.js (pure folder: rows, items, queue, status, dedupe by cur, merged spans, reset/heartbeat), store.ts (`useSessionStream(sessionId, { source })` returns folded rows + header facts; one frame clock over pace.js/reveal.js; per-row subscriptions; frames of one tick applied together; replayed text shows as is, live text is paced), stream-source.js (core/stream `connect` wrapped as a StreamSource: pass `connect`, `open`, `send`, `answer`, `stop`), mock-stream.ts (frames, 40 tokens a second).
- ChatScreen.tsx (header state chip + Stop chip, transcript, queue strip, composer), ChatRows.tsx (avatar rows as the prototype, reserved line heights while text reveals, skeleton thread), ChatComposer.tsx (never disabled, Send says Queue while working, @ # / pickers with a sealed chip on records, attach/photo/voice callbacks, model switcher with fit, runs-on chip, sheet with 44 px targets on a phone), follow.js (follow/jump state machine + pill words), composer-model.js.
- Virtualisation: reuse src/session/Transcript.* (web: column-reverse scroller windowed by chat core window.js with measured heights and an anchor; native: inverted FlatList). FlashList is not installed and RN-web's FlatList cannot anchor prepends; the windowed scroller mounts 9 to 18 rows of 10,000.
- Route /chat-demo (`?n=10000`, `?at=ms&hold=1`, `?composer=1`); /session/demo opens it (5-line edit in app/session/[id].tsx). `window.__chat` carries the meter.
- Edits to files others own: Transcript.web.tsx (heights.prune only when the rows change; it walked every key on each measure), model.ts (ESTIMATES.block), scripts/shots.mjs (`--fixed 1`, query kept in the file name). No change to @vyre/ui, tailwind.config or metro.config.
- Tests: node:test in src/chat (frames, follow, blocks+ansi, composer-model, mock-stream, stream-source). Shots: docs/work/shots/chat/ (390 and 1280, dark and paper: terminal, queued, diff, approval, composer open).
- Perf numbers: see the report to the lead (perf/chat-perf.mjs, testbox, headless Chromium, software raster).
- Not done / next: wire the real client (needs a Metro alias `@vyre/stream` -> core/stream, asked of native-core); the real send/stop/answer callbacks (threads.send, threads.stop, tasks.decide with Face ID); native (iOS/Android) not run; edit-retry/branch UI; attachments are callbacks only; model list and people/records pickers are static samples until the kernel feeds them.

### Done: task E (integration, 3 Oct 2026)
- Task A verified on testbox: `node --test "core/stream/**/*.test.js"` 70 of 70 before my changes, 79 of 79 after (live.test.js adds 4, the rest are unchanged). Perf lines as printed: `{"test":"perf-latency","transport":"loopback ws, same process","frames":3000,"p50_ms":0.34,"p95_ms":0.77,"p99_ms":1.85,"max_ms":9.28,"target_p95_ms":50,"budget_ms":300}` and `{"test":"perf-resume","kills":30,"p50_ms":6.08,"p95_ms":9.95,"p99_ms":11.36,"max_ms":11.36,"target_ms":1000}`. No flake seen, so the 50 ms assertion stays.
- Joined A, B, C: the adapter maps thread.queued, thread.sent and thread.steered through queue-state (steer is `queued`, turn and now are `picked-up`, no via stays `sent`), thread.unqueued is `user-message{state:"cancelled"}`, thread.status stopping is `status{stopping:true}`. term: the stream listens for the `term.command` event (thread = session) rather than importing core/term's `onCommand` (a feature part may not import another), so typed commands become `term-command` frames. queue-state moved to lib/queue-state.js (the boundary test forbids stream importing switchboard).
- The stream already piped live events per session; now a session with an empty log is seeded from `threads.get` (last 1000 events) when a screen opens it or when its first live event is not thread.started, with live events held until the seed is in.
- live.test.js (4 tests, real vyred with the fake claude): start a session, steer, attach, kill the socket mid-reply, resume from the cursor; the cut-off client and a never-cut client cover cursors 1..head with no gap and no repeat and fold to the same transcript (a replay may merge deltas, so frame-for-frame equality is not asserted); taken-back queued message is a cancelled frame and stop says stopping; a cold session is seeded; `term.open {session}` opens in the session's folder and a typed line reaches the stream.
- Bug found and fixed (C's "not verified"): `term.open {session}` read `threads.get`'s cwd at the wrong level and refused every session; it now reads `data.thread.cwd`. Proven by live.test.js.
- App: `@vyre/stream/*` alias (metro.config.js, tsconfig.json). `src/api/box` gains `socket(path)` and `boxOrigin()` (wire.ts passes a platform `socket`; web and native give `paths.socket`, which is a direct WebSocket or a relay channel socket). `src/chat/box-stream.ts`: core/stream client over `stream.open` tickets and `socket`, send (threads.send with uuid), stop (threads.stop), answer (threads.answer), edit-retry, retry, branch, all through the outbox. `useSessionStream` uses it for every id except `demo` (mock). ChatScreen: message actions (Edit, Retry, Branch) on a person's rows, the composer's edit mode, a note line for refusals, a header "Open full terminal" button. app/session/[id].tsx is now ChatScreen on the real stream; the Glass card sits under the header; the old transcript view is no longer reached from the route (src/session/store.ts stays, other code and tests use its pure parts). Terminal: `term.open {session}`, `term.attach` for each ticket, ws URL on the box origin, TerminalPane beside the chat (desktop) or TerminalScreen over it (phone), `frameUrl` = box origin + /app/term/frame.html on a phone.
- Verified: apps/app `npm test` 208 of 208, `npm run lint:ui` clean, `npm run typecheck` only the 5 errors in ../../deck/ui (contracts.js, mock-store.js twice, tasks.js, types.js; not touched by chat, pre-existing); core/stream/client.js and protocol.js had type errors under the app's tsc which I fixed. Web exported; shots re-taken at 390 and 1280, dark and paper, into docs/work/shots/chat/ (chat states at=1800 terminal, 3000 queued, 5500 diff, 7000 approval, composer at 3000; terminal-demo with fake-term) and viewed.
- Changed contracts (E): (1) core/stream protocol: `user-message.state` gains `cancelled` (additive). (2) core/stream: new core/stream/frame.js (kindOf, startOf), protocol.js re-exports them. (3) core/switchboard/queue-state.js and its test moved to lib/ (switchboard test imports updated). (4) core/term/index.js: the session folder lookup reads `data.thread.cwd`. (5) test/boundaries.test.js and docs/architecture/boundaries.md: three new frozen edges, `core/stream -> core/computers` (ws.js), `core/stream -> core/transcripts` and `core/term -> core/transcripts` (sanitize.js), all `next: lib`; NEEDS THE LEAD'S OK (the rule says no new exception without it). (6) apps/app: metro.config.js and tsconfig.json alias, src/api/wire.ts, box.web.ts, box.native.ts, box.d.ts gain socket and boxOrigin.
- Not run: nothing on a real box, a phone or a simulator: the real stream was proven through core/stream tests and a real vyred, not through the exported app (the app needs a box serving /app and a person session). The native WebView terminal path, edit-retry and branch from the UI, and the relay path for the stream were not exercised. docs:ref was re-run: tools, events and modules pages already held chat's tools and events; only index.md and index.json differ, in mention counts from other teams' docs, so they were not committed.

### Done: task G (group chats on the stream, 3 Oct 2026)
- core/stream: `author`/`acts_for`/`message` on every frame; kinds participant-joined/left, reaction, pin, mention, fanout, fanout-keep, text-cut (logged), presence and read-marker (ephemeral, cur 0); `parent` field for thread replies; validators, index.d.ts, toEnvelope (author is actor, acts_for the chain's first hop). routing.js `whoAnswers`, viewer.js `render` + `assertAskerCanRead` (and `log.append({asker})`), presence.js (3 s throttle), readmarks.js (per person), log merge only same message and author, server sends cursor-less frames live, client passes them without moving `last`.
- apps/app/src/chat/frames.js: rows keyed by message id with author and actsFor, provisional tail (40 chars) until text-done, text-cut, participants, presence, reactions, pins, mentions, thread parent, readUpto, fanout groups with keep.
- Tests: core/stream/group.test.js, apps/app/src/chat/frames.test.js (new cases at the end).
- Not done: the transport for read markers across a person's connections (the store and frames exist); whoAnswers is not yet called by the switchboard send path; the group UI is task H.

### Done: task I (group send path, door streaming, typecheck, 3 Oct 2026)
- Typecheck: the `Frame` typedef (apps/app/src/chat/frames.js) has author, acts_for, message, turn and corr as `string|null`. Join and leave notices use display names: `participant-joined` frames carry `name` (stream.send sets it), frames.js keeps a `names` map and `name(id)` ("person:alex" with no name reads "Alex"; never the raw id).
- Server (core/stream/group.js, registered in module.json, `npm run docs:ref` run): `stream.send {session, text, message?, mentions?, to?, people?, assistants?, default?, cwd?, group?, as?}`, `stream.react`, `stream.pin`, `stream.keep {group, keep}`, `stream.mark-read {upto}`. Author is the verified tailnet peer's login, else `as`, else `person:owner` (single-owner boxes; two people on one box use `as` from local surfaces only). Routing is whoAnswers; each answering assistant has ONE thread per group (member row, started on its first message from the person's `cwd`), the person's words go in by threads.send with `uuid` = sha1(message|assistant). The thread's frames are projected into the group log: user-message and status frames are dropped, text message ids become `<message>.<assistant name>` so a fan-out's answers are distinct, turn is `<name>/<turn>`. Tables: stream_groups_members (thread, cwd, asker, answer, last_event), stream_groups_outbox, stream_groups_marks. Start catches every thread up from last_event and re-delivers open outbox rows. Read markers: ticket carries the person, serve's new `also` option subscribes that connection to that person's markers.
- Tests (testbox3, fake claude): core/stream/group-live.test.js 5: mention routes to juno only (author assistant:juno, acts_for alex), two people route to none then @kit brings kit, fan-out gives two answer blocks + keep + react + pin, stop and start with juno's delivery held loses nothing and repeats nothing (kit's text unchanged, juno's prompt once, gapless cursors, same message id again is `duplicate`), read marker reaches alex's two connections and not chris.
- Door: merged origin/work/sealing (conflicts only in generated docs: docs/index.json and docs/reference/* taken from theirs and regenerated by docs:ref; docs/nav.json kept both ADR lines; kernel/contracts took theirs without conflict). core/stream/door-adapter.js: createDoorAdapter({message, chain|author, actsFor, turn}).event(ev), pipeDoor(log, ad, ev), drainDoor(log, events, o). text -> text-delta, tool_call -> tool-started (and text-done for the open block; later text is a new index), cut -> text-cut {note, code, class} then the message is over, done -> text-done. Tests: core/stream/door-adapter.test.js 5 (cut, provisional tail via settle, chain author/acts_for).
- Client: apps/app/src/chat/box-stream.ts `sendGroup`, `keep`, `react`, `pin`, `markRead` through write() (outbox, Idempotency-Key); box-stream.test.js checks the wiring.
- Changed contracts: (1) core/switchboard threads.send: optional `uuid`, honoured only from a first-party module caller (otherwise the Idempotency-Key rule is unchanged). (2) core/stream/server.js serve option `also(send)` (per-connection extra frames). (3) stream.open takes `as`. (4) routing.js exports `mentionedIn`. (5) participant-joined `data.name` (additive).
- Not done: a hard crash can repeat the last 100 ms of one thread's words (log flushed before the cursor; a stop is exact). threads.start has no uuid, so a crash between threads.start and the outbox mark starts a second thread. The group UI (task H) is not yet wired to sendGroup (needs a group session id and the participant list from the box). Door streaming is not yet called by any session: door-adapter takes the events, the assistant that calls door.stream is another team's. Nothing run on a real box, phone or simulator.

### Doing
Nothing running. Tasks E, G and I are committed on work/chat-03.

### Next
1. Lead: approve the three boundary edges (or say to move sanitize.js and ws.js into lib/ and I do it), merge work/chat-03.
2. Wire task H's group UI to box-stream sendGroup/keep/react/pin/markRead: first step, in apps/app/src/chat/ChatScreen.tsx pass `sendGroup` and the fan-out `keep` into GroupParts, and read the participant list from `participant-joined` frames (frames.js participants()/name()).
3. First step for the next agent (older): with a box up (testbox vyred behind /app, fake claude), open /app/session/<id> in headless Chrome, send, steer, kill the network mid-reply and shoot it; that is the one proof still missing (the app on the real stream).
3. Then: terminal over the relay (the iframe opens its own socket on the box origin), a message-actions overflow menu on a phone, and the model and people/records pickers fed from the kernel instead of the static samples.

### Needs from others
native-core owns @vyre/ui (apps/app/ui): chat-only components go under apps/app/src/chat, anything shared is asked for in team/0.2/CHAT.md.

---

# chat (0.2 history)

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
- SIGNED OFF by reviewer (read-only, no tests run - the 494/495 above is testbox, mine). LOW open:
  checkSight() runs once per mount, so an agent whose computer goes live AFTER the thread opens
  never gets the strip until reopened - should also re-check on computer.started or sight.stepped
  for this thread while sight.target is still null. Nit (not currently live): matches on `label`;
  sight.targets today sets label to the agent name itself (core/sight/index.js: `label: c.agent`),
  so this is safe as written, but if sight.targets ever grows a separate id/name field, match on
  that instead since two agents could in theory share a display label.

## RESTART (28 Sep, checkpointed on a usage-limit warning, head bc222f1d)
Status for whoever resumes: everything through @role routing is built and pushed; reviewer-2
signed off through the teammate handoff card (572/573 on 2bf8ceab); the hardening/onRecall/@role
batch (41ed798b/b61a506e/af29a073) is sent to reviewer-2, not yet answered - check for a reply
first. Nothing uncommitted; no testbox processes running.

**EXACT NEXT STEP:** the hang native-core re-hit does not reproduce on this tree (ran their exact
command, `node --test --test-timeout=15000 "deck/chat/session.test.js"` on work/chat HEAD: 21/21
pass, clean, ~2s). Their repro needs code that is NOT pushed to origin yet: work/native-core-composer
is still at d5b0ed18 on origin, but their repro was at sha d52205e1 plus an uncommitted keyup line,
plus e21c019d (voice rebuilt as tap-to-talk) and the fake-dom.js fixes team-lead mentioned - none
of that is fetchable yet. Asked native-core (msg sent) to push their latest so the already-approved
whole-branch merge (`git merge work/native-core-composer` into work/chat - team-lead OK'd this
explicitly, integrator is folding cleared shas into a stage branch separately) can actually pull
in what's needed to see the hang for real. Also answered their session-state question (no change
needed to busy/queued/steering - dictation is orthogonal, lands in ta.value like typed text; flagged
one thing to verify on their end: Esc should cancel dictation before the turn's own interrupt,
matching the rewind-overlay/hint-dismiss precedence pattern already in onEscape()).
**On resume: check the inbox for native-core's push, then run `git fetch origin
work/native-core-composer && git log --oneline -1 origin/work/native-core-composer` - if it moved
past d5b0ed18, do the whole-branch merge, resolve conflicts, run the full suite, and THEN try to
reproduce the hang on the merged tree before building anything else.** Once the hang is
resolved (or confirmed not chat's to fix), build the voice session-view states against e21c019d
(the voice ticket already landed elsewhere - capsule-pro f967b3de - so this is unblocked once the
merge lands). Also queued, not started: teammates' core/style em-dash normaliser + style.patterns
lint (tool shape ready, schemas confirmed stable), and the request-id fix for the handoff card's
correlation gap (teammates + sessions own it; they'll ping when threads.post's payload carries one
- still FIFO-by-role until then).

LESSON for whoever runs tests on testbox this session: a `node --test` run of session.test.js
(now ~900 lines, many `await wait()` calls) can look STUCK from `ps`'s %CPU column (0.2-0.5%
sampled at any instant, because most of its wall-clock time really is inside those waits, not
computing) even when it is genuinely still working and will complete in well under two minutes.
Don't kill it on a low-CPU snapshot alone - watch the SAME PID for a few samples across a couple
of MINUTES, or just let the foreground command exceed 120s and background itself; only kill it if
elapsed time keeps growing with the OUTPUT FILE staying byte-for-byte empty for several minutes,
not just a low %CPU reading. Killed it prematurely three times this session chasing what turned
out to be a plain `$` vs `$$` typo in a new test, not a hang.

## Done (28 Sep, budget 8: reconnect scroll jump - FIXED, 130f7e8d)
- Added temporary diagnostic logging (window.__WV_DEBUG, removed after) to measure() and the
  anchor-restore in window-view.js, run through native-bar budget 8 on testbox with WV_DEBUG=1.
  Found the actual mechanism, distinct from the "revealed-estimate" hypothesis in the last restart
  note: session.js's patch() replaces a changed turn/tool/user row's element directly in the DOM
  and in its own `els` cache (`el.replaceWith(nel)`) for a row whose signature changed, BEFORE
  calling layout(). window-view's own `mounted` Map keeps the OLD, now-detached node until its
  next mount() call (a few lines later in the same update()) refreshes it. A detached element's
  getBoundingClientRect() is all zeros in every browser; measure() was trusting it, corrupting the
  next-row-top chain it builds bottom-up and moving rows above it (here, msg_1's slot swinging
  140 -> 32 px) that never actually changed.
- Fix: treat a disconnected mounted element exactly like "not mounted yet" - skip it, break the
  chain, remeasure once mount() puts the real element back a moment later (window-view.js, 8 lines).
- Result across six testbox runs: anchor jump 106 px -> 4-13 px (was failing the <=1px budget
  before and after; the residual is a different, legitimate category - a row above the anchor
  measured for real for the first time, replacing its estimate, which unavoidably shifts a few px
  regardless of this bug). Catch-up time (>1000 ms budget) is separate, pre-existing reconnect-loop
  noise (unaffected by this change, already failing before it at 1296-1493 ms).
  testbox: deck/chat + deck/test 494/495 (1 pre-existing skip), 0 fail.

## Done (28 Sep, reviewer's LOW + nit on the sight strip, cfc98f23)
- LOW (18980d2d): checkSight() ran its lookup once per mount, so an agent whose computer went live
  after the thread opened never got the strip until reopened. Split into checkSight() (runs once,
  guarded by sight.checked as before) and trySight() (the actual lookup, callable again); if no
  live target is found the first time, subscribes to computer.checked-out (verified in
  core/computers/pool.js: fires with `thread: co.thread` right after a checkout's boot sets
  `state: "running"` - exactly "this thread's agent just got a live screen") and sight.stepped,
  both scoped to this thread, each retrying trySight(). Never a timer, per sight.frame's contract.
- Nit: matched sight.targets rows by `target` (the registry's own identifier) instead of `label`
  (a display name that today happens to equal it, per the reviewer's own note).
- New test (session.test.js): a computer with a display label that differs from its target,
  starting not-live, goes live via computer.checked-out, gets the strip without a reopen; a
  checked-out for a different thread does nothing more.
  testbox: deck/chat + deck/test 495/496 (1 pre-existing skip), 0 fail.

## Done (28 Sep, native-core's "Fork from here" - session.js's side wired, ffc22ef8)
- Read native-core's handoff (vyre-native-core/docs/work/native-core.md, 6fb2e02a): they built
  pickers.js/composer.js's rewindSheet(onFork, canFork) and handed the contract for session.js -
  call threads.fork {thread, at: uuid}, open the answer the way openHref does. Verified their
  answer-shape note against source: core/switchboard/index.js's record() returns `.id`, never
  `.thread`, and openHref(data, project) already falls back `data.thread || data.id`, so no
  correction needed.
  Wired onFork/canFork into openRewind()'s rewindSheet() call: onFork calls threads.fork, opens
  res.data via openHref + go() on success, leaves the original thread's view untouched (no
  patch()); canFork is CAPS.has("threads.fork"). This tree's pickers.js (not yet merged from
  native-core) and core/switchboard's threads.fork tool (no `at` param yet in this tree) don't
  have their side of this yet - the extra rewindSheet options are read by plain property access
  with no schema check, so they sit inert until both land on main and get merged in here; nothing
  further needed on chat's side once that happens.
  Flagged back for native-core/sessions in caps.js's SESSION_TOOLS comment: unlike REWIND_CODE
  (piggybacks on threads.commands via LINKED), nothing yet marks threads.fork known-true before a
  first real use, so the item may sit disabled forever on a box that has never forked - worth a
  LINKED entry once they know which release ships it alongside.
  testbox: deck/chat + deck/test + core/switchboard 549/550 (1 pre-existing skip), 0 fail;
  boundaries + docs-check 66/66.
- Confirmed budget 8's catch-up time on a tree with pwa's reconnect-backoff fix (be3f5554) merged
  in (a disposable local branch, never pushed): 64-70ms across three runs, well under the 1000ms
  budget - the 1296-1493ms seen earlier was testing without that fix, not a chat regression. Jump
  on that merged tree: 6-13px (same residual category, a faster reconnect catches the
  estimate-to-real correction mid-flight slightly differently).

## Done (28 Sep, dropped the local STATUS map for sessions' canonical thread.status, f8ce247a)
- Lead's ask, following sessions' 6e2f8a71 (thread.status/canonical_status, lib/thread-status.js)
  and 28a8b4f8 (the 8th state, "paused"). Full detail: see the commit message (f8ce247a) - the
  short version: session.js reads canonical_status/thread.status directly now (BUSY, waitingOn,
  idleClosed all use the canonical words); core/session-state.js's guess() call sites (thread.sent,
  thread.tool, ask.raised/answered, thread.finished, thread.stopped) guess the canonical word
  instead of the old internal one, and thread.stopped's guess now mirrors threadStatus()'s own
  reason-parsing for the best guess before any real thread.status arrives.
- Folded in nearby (app-design's item 4, since it's the same lease-bar code drawHead touches):
  "No one is typing" no longer shows on a solo session with nothing to report (no holder, nothing
  to resume, no error) - the lease bar hides instead.
- testbox: deck/chat + deck/test 563/564 (1 pre-existing skip), 0 fail; boundaries + docs-check 66/66.

## Done (28 Sep, app-design's review: kbd chips, a real rewind overlay, a focus trap, 74017fb8)
- ask-item.js's Allow once (A) / Deny (D) key hints now use the shared .kbd chip (key-hint.md)
  instead of custom plain text.
- The rewind sheet (Esc Esc) is now a real overlay (position: fixed, a scrim, sheet.css's
  --scrim/--float tokens, centred on desktop matching sheet.css's own breakpoint) instead of drawn
  inline above the composer - on a phone that stack (lease bar, todos, queued row, this) pushed the
  composer's mode row off the bottom of the viewport. Keyboard routing (rewind.key(e) in onKey) is
  unchanged; only where it's drawn moved. A tap on the scrim closes it (lightbox.js's convention).
- lightbox.js: Tab is now trapped to the one focusable control while open, so aria-modal="true"
  keeps its promise; was explicitly documented as not doing this.
- Still open from that review: the item 2 fix (deck.css's base `.lbl` mono/uppercase is the retired
  label style, ~146 callers across the whole Deck) is cross-team, not chat's alone to land.
  testbox: deck/chat + deck/test 563/564 (1 pre-existing skip), 0 fail; boundaries + docs-check 66/66.
  SIGNED OFF by reviewer-2 (621/622 on their rerun of deck/chat+deck/test+boundaries+docs-check+
  core/switchboard, covering this plus 130f7e8d/cfc98f23/ffc22ef8 together).

## Done (28 Sep, the teammate handoff card - teammates.md section 3, 2bf8ceab)
- blocks.js's handoffCard(): a session calling team_ask/team.ask gets its own card (tool-row.md's
  Handoff variant, app-design 83434944) - the teammate's avatar tile (agentAv, never coloured, per
  avatar.md's ruling), role name, a plain "Teammate" tag, verb Asked -> Replied. The reply is turn
  prose (markdown), not a code block. Dispatched from session.js's itemEl on tool name team_ask/
  team.ask instead of the generic toolCard.
- core/grouping.js: a handoff is exempt from the "folded run" collapse (BY_NAME/foldable), the
  same exemption a plan or a todo list gets - always its own visible line, new test in
  grouping.test.js.
- core/session-state.js: onTool now captures a live thread.tool event's `input` when present (most
  tools build it up as the call streams; a handoff's whole input is one small object, present from
  the start, and the row needs the role right away, not after a reopen). New attachHandoffReply():
  a teammate's result (threads.post -> thread.sent {kind: "teammate-result"}) attaches to the open
  handoff that asked, never an ordinary user message; the busy-session path (thread.queued {kind:
  "teammate-result"}) is suppressed the same way.
- KNOWN GAP, flagged to teammates/sessions (not fixable from chat's side): threads.post's
  teammate-result payload carries no request id, only the role - correlation is FIFO-by-role
  (oldest open handoff for that role), exact for the common one-open-ask-per-teammate case,
  ambiguous with more than one open at once for the same teammate.
- Not done: this session's own live team_ask events (Chat as the composer that TYPES @role, per
  section 2) don't exist yet - this renders whatever a MODEL's team_ask tool call produces, once
  section 1 and 2 land. Nothing to verify end-to-end against yet on this tree.
  testbox: deck/chat + deck/test 566/567 (1 pre-existing skip), 0 fail; boundaries + docs-check 66/66.
  SIGNED OFF by reviewer-2 (572/573 on their rerun).

## Done (28 Sep, the hang hardening + onRecall + @role routing, 41ed798b/b61a506e/af29a073)
- 41ed798b: composer.js's holdTimer/leaseTimer/fileTimer now .unref?.() right after setTimeout (a
  no-op in the browser; stops one dangling Node-test timer from keeping a whole glob's process
  alive). t.after(stop) on this session's two newest session.test.js tests, replacing a trailing
  stopN() a thrown assertion would skip. Team-lead's cheap hardening after the hang could not be
  reproduced on this tree; not chased further per their steer.
- b61a506e: session.js's onRecall - opens a "From your past sessions" hit via threadHref+go(),
  landing at hit.ts on the existing ?at= deep link rather than a new seq-keyed one. Inert
  (native-core's composer.js side, fae441ff, is still unmerged anywhere) until that lands.
- af29a073: "@role" (teammates.md section 2) - a new "teammate" draft kind in composer-state.js
  (matches "!"/shell and "#"/memory's pattern exactly: teammateRole() finds the slug, draftBody()
  strips "@role "). composer.js's askTeammate() calls team.ask first always (works whether
  team.default is on or off - only creation is gated), and on not_found offers to create (gated on
  team.default.get) with an inline confirm ("Create and send" / "Don't create, answer here" - the
  latter sends the WHOLE original draft, never silently edited). Real gotcha found and fixed while
  building it: team.ask's not_found must be checked directly (r.error.code, matching
  session.js's own recall.transcript not_found pattern), never routed through CAPS.use - a role
  simply not existing yet answers the same generic 404 an absent tool would, and CAPS's own
  isMissing() can't tell those apart from the status code alone, so it would have marked team.ask
  missing FOR GOOD the first time any one role came up empty.
  Fully built and tested against mocks even though core/team doesn't exist on any branch that's
  reached me yet - same as any tool a box might not have.
  testbox: deck/chat + deck/test 568/569 (1 pre-existing skip), 0 fail; boundaries + docs-check
  66/66; deck/chat/*.test.js (native-core's original hang-report glob) 97/97, clean, re-run after
  every commit in this batch.

## Done (28 Sep, native-core-composer merge, hang found and killed, e9d68c84)
- Merged origin/work/native-core-composer (65296734) into work/chat: clean, no conflicts (voice.js,
  the composer's voice UI, native-bar.md, stream.js's fast-reconnect probe).
- Reproduced the hang native-core kept re-hitting: session.test.js's test 12 (typing steers/queues/
  rewind) threw partway through - native-core's pickers.js now always offers "Fork from here" in
  the rewind sheet's keyboard cycling (allowed()), even while canFork() was still null, so
  ArrowLeft landed on Fork instead of "Restore code". The thrown assertion skipped that test's own
  stop4(), leaving a mounted session still listening, which crossed thread ids into test 13's
  assertions and doubled test 17's sight-refresh count - three failures, one cause, and the still-
  live session's stream kept the whole file from exiting (a 15s file-level timeout on top).
  Fixed pickers.js's allowed() to gate Fork on forkOk() === true, the same pattern RESTORES already
  uses for codeOk() (still rendered, disabled, in the visible list either way - only cycling order
  changed). Updated session.test.js's rewind-sheet assertion for the now-real fourth option.
  Separately found and fixed (pwa's file per be3f5554, not native-core's as I first told them - a
  one-line contract-safe change either way, corrected the attribution after reviewer-2 caught it):
  core/resilience/stream.js's fastReach() interval and its abort setTimeout were never unref'd, so
  two real, never-closing sockets survived every test that ever went "reconnecting" - this is what
  actually kept the process alive for the file-level timeout once the crossed-session symptom above
  was ruled out as the sole cause.
  Also added /chat/core/voice.js to deck/sw.js's SHELL list (pwa's file per fa2e43e's precedent,
  told pwa) so the new voice module installs offline.
  testbox: deck/chat + deck/test + core/switchboard + core/resilience + local/voice 589/589 (2 skip,
  0 fail); boundaries 66/66. docs-check: 2 pre-existing failures, both in native-core's own newly-
  merged docs (docs/work/pwa.md fails to render, em dashes in docs/design/native-bar.md) - flagged
  to native-core, not chat's files.

## Done (28 Sep, session-view voice states: recording/transcribing/no-key, 5bb97447)
- composer.js already had recording (the Listening pill) and no-key (the Settings note) from
  native-core's merge; added the missing third state: a stop tap now sets voiceStopping, shows
  "Transcribing…" in the pill and a "stopping" mic class/aria-label, held until onDone/onError
  answers (matches local/voice/listen.js's TAIL_MS wait) - Esc/cancel still clears everything at
  once, no transcribing flash on a cancel. New composer-voice.test.js cases cover all three states.
- Found and fixed a real bug in deck/test/fake-dom.js (a shared test helper, not chat's alone, but
  a one-line variadic fix matching the real DOM API): classList.add/remove only ever took their
  first argument, silently dropping the rest - finishTalk()'s existing classList.remove("on",
  "held") never actually removed "held" under test. No passing assertion changed; this only fixes
  removals that were silently no-ops before.
  testbox: deck/chat + deck/test + core/switchboard + core/resilience + local/voice 588/588 (2
  skip, 1 pre-existing cancelled), 0 fail; boundaries 5/5.

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
- FIRST (whoever resumes): send 2bf8ceab (the handoff card) to reviewer-2 - the other five already
  signed off (621/622).
- The lead's three remaining chat items (user's picks, 28 Sep), each real work, not started:
  1. @role routing in the composer (teammates.md section 2): typing @name at the start of a
     message sends team.ask instead of spending this session's turn; auto-create via team.add on
     first use (team.default check, generic brief, model Sonnet); an inline confirm card
     ("There's no research teammate yet...") with a "Don't create, answer here" fallback. Lives in
     composer.js/composer-state.js, chat's own files - no native-core split needed for this part
     (they're doing #5, /find, and the composer half of #3).
  2. Session-view states for voice: recording, transcribing, no-key prompt (team-lead: capsule-pro
     owns the setting/tool, native-core owns the composer mic - chat's part is these three states
     in the session view once native-core's composer piece exists to hang them off of).
  3. "From your past sessions" inline IQ card: memory-iq's recall.related shape is agreed
     (recall.related({project_cwds, text, limit?}) -> {hits: [{session, seq, ts, name, title, cwd,
     snippet, score}]}, msg to chat's inbox) - build the card (name/ts/snippet, a link per hit via
     recall.thread({session})) and the composer-side trigger (as the person types, debounced).
  None of these three are started - flagging honestly rather than shipping a rushed thin slice of
  all three. Pick one, build it whole, then the next.
- Budget 8's residual 4-13 px jump (down from 106 px; 6-13 px on a tree with pwa's reconnect fix
  merged): a different, smaller category than the fix above - a row above the anchor measured for
  real for the first time, replacing its ESTIMATES default. Not chased further this session (the
  plan's ask was the specific mechanism found and fixed); worth a look if the native-bar budget
  wants strict <=1px, e.g. tighter per-kind estimates or pre-measuring rows just above the viewport
  before they're needed. Catch-up time itself is confirmed NOT a regression (64-70ms once pwa's fix
  is in the tree) - nothing further to do there once main picks it up.
- Fork from here: told native-core session.js's side landed (ffc22ef8); waiting on their pickers.js
  (6fb2e02a) and the switchboard's `at` support to merge to main, then a real end-to-end Chrome
  verification. The canFork probe gap (caps.js) needs native-core/sessions to say which release
  ships threads.fork's `at` support, for a LINKED entry.
- app-design's review item 2 (deck.css's base `.lbl` is the retired mono/uppercase label style,
  ~146 callers across the whole Deck): cross-team, not chat's alone to land - flagged to whoever
  owns deck.css/tokens generally (app-design or pwa).
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

### Done: task H (group chat UI, 3 Oct 2026; apps/app/src/chat)
- Header is one compact row (ChatHeader.tsx): back chevron, stacked faces (3, then +n, viewer left out), one-line title, one quiet line (record, space; "muted" is appended there when on). State and Stop moved to StatusLine.tsx under the transcript (fixed height, so presence never moves the transcript; Stop only exists while there is something to stop). Tapping the header opens AboutSheet.tsx: people and assistants (with role), record, what assistants see + sealed count, where it runs with Move, full terminal, mute, pin (mute/pin stay outside the scroll). The sealed note shows once per chat under the header (localStorage in try/catch; a failing store shows it again, never hides it).
- group.js (pure, 11 tests): a side folder next to frames.js, fed the same frames from store.ts: authors and acts_for ("kit, for Chris" / "for you"), participants, presence line, reactions, pins, thread replies, mentions, read marker + the "New" divider (viewer's own marker only, never before a marker exists), asks addressed to the asker (others see WaitingCard, read-only "waiting for Chris"), fan-out sets and keep, text-cut notes. frames.js (task G) also folds some of these; the UI reads group.js only, so G's shapes can change without touching the screens as long as top-level author/acts_for/message and the data fields in the brief hold.
- Rows (ChatRows.tsx, GroupParts.tsx): per-message block per author keyed by message id, so two concurrent assistants never share text; mention highlight, pin mark, reactions, Reply / React / Pin tools (only when the chat has participants), reply-in-thread strip above the composer. FanoutSet.tsx: side by side at 1280; snap cards with page dots at 390; Keep this appears once an answer is done ("Still answering" before); kept card marked, others dimmed "Not kept"; set draws at the first member that has a row.
- Composer: "Ask all" chip (shown with 2+ assistants) and @mentions of 2+ assistants make a fan-out; composer-model.js `mentionedAssistants`, `sendTargets` (tests added, old ones kept). onSend(text, {to, fanout}).
- Mock: groupScript in mock-stream.ts (two people, kit for chris and juno for alex streaming at once, chris's approval, reaction, pin, thread reply, a fan-out of three with a cut note, read marker). Route /chat-demo?scenario=group (also &at=ms&hold=1, &note=0, &about=1). Source extras (optional): sendGroup, keep, react, pin, markRead.
- Changed files of others: Blocks.tsx (BlockCtx.onReplyTo), store.ts (group folder, sendTo, social actions), ChatScreen.tsx, ChatComposer.tsx, ChatRows.tsx (kept as the chat team's own). Not touched: core/stream, frames.js, @vyre/ui.
- Found: @vyre/ui Sheet drops className on its primitives in the exported web build (no scrim, background or padding; computed style empty). AboutSheet draws its own sheet with style props; swap to Sheet when native-core fixes it (told native-core).
- G's frames.js writes a notice row "person:alex joined"; ChatRows strips the family prefix. Raw ids in a notice are G's to name.
- Not wired: the real send path for sendGroup/keep/react/pin/markRead (box-stream.ts has none of them; the mock does); read marker is sent on send only; participant cards are rows (no card screen); native not run.
- Numbers (testbox3, headless Chromium, software raster, load 9-13, so noisy): chat-perf paint.first p95 135.1 ms, paint.delta p95 140.7 ms (n 81; baseline commit 1cb88233f in the same conditions: 90.8 / 111.5); group scenario with concurrent streams paint.delta p50 98.6, p95 137.0, max 261.7 (n 189), target 300. scroll.fling 24 fps (baseline 32.1), scroll.hard 22.6 (baseline 18.2), keystroke p95 76.7 (baseline 85.7): the 60 fps and 33 ms targets fail in both, so the software-raster box cannot judge them. Tests 228/228, lint:ui clean, typecheck only frames.js author/message/acts_for on the Frame typedef (task G's file).
- Shots: docs/work/shots/chat/group-{390,1280}-{header,sealed-note,about,concurrent,unread,fanout-streaming,fanout-set}-{dark,paper}.png.
