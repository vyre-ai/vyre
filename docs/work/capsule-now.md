# capsule-now

Branch: work/capsule-now · Worktree: ../vyre-capsule-now · Owner session: capsule-now

Fixes from the user's live testing of the Electron Capsule (local/capsule) and vyred. The native
Swift Capsule (work/capsule-pro) carries the same behaviour later: the rules below are written for
them, one per fix.

## Rules for the Swift Capsule

1. **Quick answers read the memory on screen.** When a quick question (Ask Claude) is sent for the
   same words memory just answered, the lines the memory box shows go into the system-prompt append
   under "What the user's own notes say:", one per line, with ages: a fact as
   `<fact> (noted <age> ago)`, a quote as `The user said, <age> ago: "<quote>"` or
   `Claude said, ...`. Then the instruction to answer from them and say when ("a Honda Civic (you
   said so 2 weeks ago)"). Only what is on screen: the distilled fact and the first three sources.
   Facts under the bar and `more` are not sent. No memory on screen: QUICK_APPEND alone. The prompt
   itself stays the user's words. Reference: `bridge.js` `memoItems`, `memoLines`, `quickAppend`.
2. **Quotes are quotes.** A `recall.search` hit is drawn as `You said, 2 weeks ago: "..."` (role
   assistant: `Claude said`), with its session as a small link. The distilled fact from
   `memory.relevant`, when there is one, is the first line. Label: "From memory" when there is a
   fact, "From your sessions" when there are only quotes. The page draws `memo` items from the
   bridge; it does not rebuild them.
3. **Notices are status, not answer.** A `thread.text` with `notice: true` never joins the answer
   or a DM message. Keep the newest as `notice` and draw it as one faint mono line under the answer
   (or under the DM list). The switchboard now emits a limit notice only at utilization >= 0.8 or
   status rejected, once per status.
4. **The question is the user's line.** Reply view order: "You" + the question; then a head with
   who answers (e.g. Claude) and the state/cost; then the memory box; then the answer.
5. **A session busy in a terminal gets queued messages.** `threads.send` from a person's surface
   returns `{sent:false, queued:true, thread, name, note}` for a session another process has open.
   Show `note` ("<name> is busy in your terminal. I'll hand it your message when this turn ends.")
   and a status line "Queued for <name>: it gets this when its current turn ends." The reply is the
   thread's as usual: `thread.sent` with `queued` marks it handed over ("handed over"), then
   `thread.text` (done) and `thread.finished` arrive when the answering turn ends. No caret while
   queued. No "Send now (interrupt)": there is no interrupt path into a terminal session.

## Done
- 1ffb28a fix(switchboard): limit notice only at >= 80% or rejected; `lowlimit` in fake-claude.
- 4e559d3 fix(capsule): memory in quick prompts, quotes as quotes, notices as status, question line.
- 975436c feat: queued messages for sessions busy in a terminal (switchboard, harness,
  Capsule, CLI).

## Doing
- Nothing. Waiting for the lead to restart the user's test Capsule.

## Next
- Esc on a queued reply only stops following; the message still goes. A `threads.unqueue` for an
  undelivered message would let Esc withdraw it.
- The reply arrives whole at the turn's end (the Stop hook's `last_assistant_message`), not
  streamed: streaming from the transcript would need a file watch or polling faster than 60 s.
- A queued message for a session that is later resumed headless is delivered at that child's Stop.

## Needs from others
- capsule-pro: carry rules 1 to 5 into the Swift Capsule.
- switchboard: a new migration (`threads_inbox`) was appended to `MIGRATIONS`; if work/switchboard
  also appends one, order them at merge.

## Changed contracts
- `threads.send`: new result `{sent:false, queued:true, open_elsewhere:true, thread, name, note}`
  for a person's caller when the session is open elsewhere. Callers `mcp*` and `harness*` still get
  the old refusal.
- New internal tools `threads.inbox {session, via}` -> `{messages}` and
  `threads.replied {session, text}` -> `{replied}`. New event `thread.queued {queued, text, surface}`.
  `thread.sent` gains `queued` and `via` when the Harness hands words over.
- `harness.stop` may now return `{decision:"block", reason:"Message from the user via ..."}` for
  queued words; `harness.enrich` may prepend them to its text.
- `thread.text` notices: switchboard `limit()` emits only at utilization >= 0.8 or rejected
  (`LIMIT_NOTICE_AT`).
- Capsule snapshot: `reply.notice`, `reply.queued`, `reply.memory.memo`, `dm.notice`; recall
  results carry `memo` and each source `kind` ("fact" or "quote") and `role`.

## Tests
- local/capsule/lib/bridge.test.js 29/29, state.test.js 14/14, core/switchboard 26/26,
  core/harness 19/19, test/harness.test.js 13/13, core/cli switchboard-cli 11/11.
- Perf: nothing added polls or runs while hidden (the queue is read only inside hooks that already
  run). perf-check was not run: it measures a running Capsule and the user's is live.
